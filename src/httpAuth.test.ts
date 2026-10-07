import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startHttpServer } from "./http.js";

test("caller API keys authenticate, isolate sessions and accounts, preserve scopes, and honor revocation", async () => {
  const revoked = new Set<string>();
  let unavailable = false;
  const api = createServer((req, res) => {
    assert.equal(req.headers["x-forwarded-proto"], "https");
    const token = req.headers.authorization?.replace("Bearer ", "");
    res.setHeader("Content-Type", "application/json");
    if (unavailable) { res.writeHead(502).end('{}'); return; }
    if (!["exd_Alice", "exd_Bob", "exd_WriteOnly"].includes(token || "") || revoked.has(token!)) {
      res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    if (req.method === "GET" && token === "exd_WriteOnly") {
      res.writeHead(403).end(JSON.stringify({ error: "Forbidden", message: "API key is not authorized for this route" })); return;
    }
    if (req.method === "POST" && token === "exd_Bob") {
      res.writeHead(403).end(JSON.stringify({ error: "Forbidden", message: "API key is not authorized for this route" })); return;
    }
    if (req.method === "POST") {
      req.resume(); res.end(JSON.stringify({ id: "new", name: "New" })); return;
    }
    res.end(JSON.stringify({ drawings: [{ id: token, name: token }], totalCount: 1 }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address(); assert.ok(address && typeof address === "object");
  const http = await startHttpServer({ EXCALIDASH_URL: `http://127.0.0.1:${address.port}`, MCP_AUTH_MODE: "excalidash", EXCALIDASH_PROXY_PROTO: "https", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "0" });
  const listener = http.address(); assert.ok(listener && typeof listener === "object");
  const endpoint = `http://127.0.0.1:${listener.port}/mcp`;
  let counter = 0;
  const send = async (token: string | null, method: string, params: unknown = {}, session?: string) => {
    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++counter, method, params }) });
    const text = await r.text();
    const body = JSON.parse(text.startsWith("event:") ? text.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : text);
    assert.equal(r.headers.get("content-type"), "application/json");
    if (r.ok) {
      assert.match(r.headers.get("server-timing") || "", /^auth;dur=[0-9.]+$/);
      assert.equal(r.headers.get("cache-control"), "private, no-store");
    }
    return { status: r.status, session: r.headers.get("mcp-session-id")!, body, challenge: r.headers.get("www-authenticate") };
  };
  const init = (token: string | null) => send(token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  try {
    assert.equal((await init(null)).status, 401);
    const invalid = await init("exd_Invalid"); assert.equal(invalid.status, 401); assert.ok(invalid.challenge?.startsWith("Bearer"));
    const alice = await init("exd_Alice"); assert.equal(alice.status, 200);
    const bob = await init("exd_Bob"); assert.equal(bob.status, 200);
    assert.notEqual(alice.session, bob.session);
    const writeOnly = await init("exd_WriteOnly"); assert.equal(writeOnly.status, 200);
    for (const [key, session] of [["exd_Alice", alice.session], ["exd_Bob", bob.session]] as const) {
      const r = await send(key, "tools/call", { name: "list_drawings", arguments: {} }, session);
      assert.equal(r.status, 200); assert.ok(!r.body.result.isError);
      assert.equal(JSON.parse(r.body.result.content[0].text).drawings[0].id, key);
    }
    assert.equal((await send("exd_Bob", "tools/list", {}, alice.session)).status, 403);
    assert.equal((await send(null, "tools/list", {}, alice.session)).status, 401);
    const readDenied = await send("exd_WriteOnly", "tools/call", { name: "list_drawings", arguments: {} }, writeOnly.session);
    assert.equal(readDenied.body.result.isError, true);
    const writeDenied = await send("exd_Bob", "tools/call", { name: "create_drawing", arguments: { name: "Denied" } }, bob.session);
    assert.equal(writeDenied.body.result.isError, true);
    revoked.add("exd_Alice");
    assert.equal((await send("exd_Alice", "tools/list", {}, alice.session)).status, 401);
    unavailable = true;
    assert.equal((await init("exd_Bob")).status, 503);
  } finally {
    http.closeAllConnections(); api.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => http.close(() => resolve())), new Promise<void>((resolve) => api.close(() => resolve()))]);
  }
});
