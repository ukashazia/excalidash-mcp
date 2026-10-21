import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { startHttpServer } from "../../http.js";
import { PgOAuthStore } from "../store.js";
import { testPostgres } from "./postgres.js";
const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw Error("No listener");
  return a.port;
};
export async function fixture(allowedCallback?: string) {
  const pg = await testPostgres();
  const keys = new Map<
    string,
    { user: string; scopes: string[]; revoked: boolean; id: string }
  >();
  const created: {
    token: string;
    id: string;
    user: string;
    scopes: string[];
  }[] = [];
  const observedCookies: string[] = [];
  let keySeq = 0,
    unavailable = false;
  const api = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (unavailable) {
      res.writeHead(503).end("{}");
      return;
    }
    const cookie = req.headers.cookie || "";
    observedCookies.push(cookie);
    const user = /excalidash-access-token=(alice|bob)/.exec(cookie)?.[1];
    if (req.url === "/api/auth/me") {
      if (!user) {
        res.writeHead(401).end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          user: {
            id: user,
            name: user === "alice" ? "Alice" : "Bob",
            email: `${user}@example.test`,
          },
        }),
      );
      return;
    }
    if (req.url === "/api/csrf-token") {
      res.setHeader(
        "Set-Cookie",
        "excalidash-csrf-client=server-issued-csrf-client; Path=/; HttpOnly; SameSite=Lax",
      );
      res.end(JSON.stringify({ token: "csrf-token", header: "x-csrf-token" }));
      return;
    }
    if (req.url?.startsWith("/api/auth/api-keys")) {
      if (
        !user ||
        req.headers["x-csrf-token"] !== "csrf-token" ||
        !cookie.includes("excalidash-csrf-client=server-issued-csrf-client")
      ) {
        res.writeHead(403).end("{}");
        return;
      }
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { scopes } = JSON.parse(body);
        const id = String(++keySeq),
          token = "exd_FixtureKey" + id;
        keys.set(token, { user, scopes, revoked: false, id });
        created.push({ token, id, user, scopes });
        res.writeHead(201).end(JSON.stringify({ token, apiKey: { id } }));
        return;
      }
      if (req.method === "DELETE") {
        const id = req.url.split("/").at(-1),
          key = [...keys.values()].find((k) => k.id === id && k.user === user);
        if (!key) {
          res.writeHead(404).end("{}");
          return;
        }
        key.revoked = true;
        res.end("{}");
        return;
      }
    }
    const bearer = req.headers.authorization?.replace("Bearer ", "") || "";
    const key = keys.get(bearer);
    if (!key || key.revoked) {
      res.writeHead(401).end("{}");
      return;
    }
    if (req.method === "GET" && !key.scopes.includes("drawings:read")) {
      res
        .writeHead(403)
        .end(
          JSON.stringify({
            error: "Forbidden",
            message: "API key is not authorized for this route",
          }),
        );
      return;
    }
    if (req.url?.startsWith("/api/drawings?")) {
      res.end(
        JSON.stringify({
          drawings: [{ id: key.user, name: key.user }],
          totalCount: 1,
        }),
      );
      return;
    }
    if (req.url === "/api/drawings" && req.method === "POST") {
      req.resume();
      res.end(JSON.stringify({ id: "created", name: "New" }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  const apiPort = await listen(api);
  // Reserve a stable public URL before constructing the adapter's discovery metadata.
  const reservation = createServer(),
    port = await listen(reservation);
  await new Promise<void>((r) => reservation.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    EXCALIDASH_URL: `http://127.0.0.1:${apiPort}`,
    MCP_PUBLIC_URL: origin + "/mcp",
    MCP_AUTH_MODE: "oauth",
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: String(port),
    MCP_OAUTH_DATABASE_URL: pg.url,
    MCP_OAUTH_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    MCP_OAUTH_REDIRECT_URIS:
      origin + "/callback" + (allowedCallback ? "," + allowedCallback : ""),
  };
  let adapter = await startHttpServer(env);
  const store = new PgOAuthStore(pg.url);
  return {
    origin,
    env,
    store,
    keys,
    created,
    observedCookies,
    setUnavailable: (value: boolean) => (unavailable = value),
    async restart() {
      adapter.closeAllConnections();
      await new Promise<void>((r) => adapter.close(() => r()));
      adapter = await startHttpServer(env);
    },
    async close() {
      adapter.closeAllConnections();
      api.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => adapter.close(() => r())),
        new Promise<void>((r) => api.close(() => r())),
      ]);
      await store.close();
      pg.close();
    },
  };
}
