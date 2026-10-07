#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { configFromEnv, ExcaliDashClient, type ExcaliDashConfig } from "./excalidash.js";
import { createServer as createMcpServer } from "./index.js";

const DEFAULT_PORT = 8080;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

type HttpConfig = {
  host: string;
  port: number;
  maxBodyBytes: number;
  maxSessions: number;
  sessionIdleMs: number;
};

const positiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const portNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("MCP_HTTP_PORT must be an integer between 0 and 65535");
  }
  return parsed;
};

export const httpConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig => ({
  host: env.MCP_HTTP_HOST?.trim() || "0.0.0.0",
  port: portNumber(env.MCP_HTTP_PORT, DEFAULT_PORT),
  maxBodyBytes: positiveInteger(
    env.MCP_MAX_BODY_BYTES,
    DEFAULT_MAX_BODY_BYTES,
    "MCP_MAX_BODY_BYTES",
  ),
  maxSessions: positiveInteger(
    env.MCP_MAX_SESSIONS,
    DEFAULT_MAX_SESSIONS,
    "MCP_MAX_SESSIONS",
  ),
  sessionIdleMs: positiveInteger(
    env.MCP_SESSION_IDLE_MS,
    DEFAULT_SESSION_IDLE_MS,
    "MCP_SESSION_IDLE_MS",
  ),
});

/**
 * Request-target path without the query string. Never parses the attacker
 * controlled Host header: building a URL from it throws on a malformed value,
 * and a throw inside the request listener terminates the process.
 */
export const requestPathname = (rawUrl = "/"): string => {
  const queryStart = rawUrl.indexOf("?");
  const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  return path.startsWith("/") ? path : `/${path}`;
};

const jsonRpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void => {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

const readJsonBody = async (
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new RangeError("Request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

type SessionEntry = {
  transport: NodeStreamableHTTPServerTransport;
  lastSeen: number;
  credentialHash?: string;
};

export const startHttpServer = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<Server> => {
  const callerAuth = env.MCP_AUTH_MODE === "excalidash";
  const excalidashConfig: ExcaliDashConfig = callerAuth
    ? { url: env.EXCALIDASH_URL?.trim() || "", token: "", drawingId: undefined, ...(env.EXCALIDASH_PROXY_PROTO === "https" ? { proxyProto: "https" as const } : {}) }
    : configFromEnv(env);
  if (!excalidashConfig.url) throw new Error("EXCALIDASH_URL is required");
  const httpConfig = httpConfigFromEnv(env);
  const client = new ExcaliDashClient(excalidashConfig);
  const sessions = new Map<string, SessionEntry>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const closeSession = (id: string): void => {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    void entry.transport.close().catch(() => undefined);
  };

  // Abandoned sessions are never closed by their client, so without this sweep
  // each initialize leaks one transport for the lifetime of the process.
  const sweepIdleSessions = (): void => {
    const cutoff = Date.now() - httpConfig.sessionIdleMs;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen <= cutoff) closeSession(id);
    }
  };

  const sweeper = setInterval(
    sweepIdleSessions,
    Math.min(SWEEP_INTERVAL_MS, httpConfig.sessionIdleMs),
  );
  sweeper.unref();

  type ParsedBody = { ok: true; body: unknown } | { ok: false };

  const parseBody = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<ParsedBody> => {
    if (req.method !== "POST") return { ok: true, body: undefined };
    try {
      return { ok: true, body: await readJsonBody(req, httpConfig.maxBodyBytes) };
    } catch (error) {
      if (error instanceof RangeError) {
        jsonRpcError(res, 413, -32000, error.message);
      } else {
        jsonRpcError(res, 400, -32700, "Invalid JSON body");
      }
      return { ok: false };
    }
  };

  const readSessionId = (req: IncomingMessage): string | undefined => {
    const header = req.headers["mcp-session-id"];
    return Array.isArray(header) ? header[0] : header;
  };

  const openSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    token?: string,
  ): Promise<void> => {
    sweepIdleSessions();
    if (sessions.size >= httpConfig.maxSessions) {
      jsonRpcError(res, 429, -32000, "Too many active MCP sessions");
      return;
    }

    const transport = new NodeStreamableHTTPServerTransport({
      // Tools return a single completed result; JSON avoids SSE overhead and
      // allows gateways to compress drawing and base64 image responses.
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id): void => {
        sessions.set(id, { transport, lastSeen: Date.now(), credentialHash: token ? createHash("sha256").update(token).digest("hex") : undefined });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const sessionClient = token
      ? new ExcaliDashClient({ url: excalidashConfig.url, token, ...(excalidashConfig.proxyProto ? { proxyProto: excalidashConfig.proxyProto } : {}) })
      : client;
    await createMcpServer(sessionClient, excalidashConfig.drawingId).connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const authenticate = async (req: IncomingMessage, res: ServerResponse): Promise<string | null> => {
    const match = /^Bearer (exd_[A-Za-z0-9_-]+)$/i.exec(req.headers.authorization || "");
    if (!match) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="ExcaliDash MCP"');
      jsonRpcError(res, 401, -32000, "An ExcaliDash account API key is required");
      return null;
    }
    const token = match[1]!;
    const base = excalidashConfig.url.replace(/\/+$/, "");
    const api = base.endsWith("/api") ? base : `${base}/api`;
    try {
      // ExcaliDash 0.6.5 has no key introspection endpoint. Its drawing route
      // validates the key before scope authorization. A precise scope-denial
      // response therefore also confirms a valid account key (e.g. write-only).
      const response = await fetch(`${api}/drawings?limit=1&offset=0`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(excalidashConfig.proxyProto ? { "X-Forwarded-Proto": excalidashConfig.proxyProto } : {}) },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (response.ok) {
        // Drain the small probe response so its connection can be reused.
        await response.arrayBuffer();
        return token;
      }
      if (response.status === 403) {
        const detail = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        if (detail?.error === "Forbidden" && detail.message === "API key is not authorized for this route") return token;
        jsonRpcError(res, 403, -32000, "This API key is not supported by ExcaliDash");
        return null;
      }
      await response.body?.cancel();
      if (response.status === 401) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="ExcaliDash MCP", error="invalid_token"');
        jsonRpcError(res, 401, -32000, "Invalid or revoked ExcaliDash API key");
      } else {
        jsonRpcError(res, 503, -32000, "ExcaliDash authentication is unavailable");
      }
    } catch {
      jsonRpcError(res, 503, -32000, "ExcaliDash authentication is unavailable");
    }
    return null;
  };

  const routeMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const authStarted = performance.now();
    const token = callerAuth ? await authenticate(req, res) : undefined;
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `auth;dur=${(performance.now() - authStarted).toFixed(1)}`);
      res.setHeader("Cache-Control", "private, no-store");
    }
    if (callerAuth && !token) return;
    const parsed = await parseBody(req, res);
    if (!parsed.ok) return;
    const { body } = parsed;

    const sessionId = readSessionId(req);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      if (callerAuth && existing.credentialHash !== createHash("sha256").update(token!).digest("hex")) {
        jsonRpcError(res, 403, -32000, "MCP session belongs to a different API key");
        return;
      }
      existing.lastSeen = Date.now();
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(body)) {
      await openSession(req, res, body, token || undefined);
      return;
    }

    jsonRpcError(
      res,
      sessionId ? 404 : 400,
      sessionId ? -32001 : -32000,
      sessionId ? "Session not found" : "MCP session initialization required",
    );
  };

  const failRequest = (res: ServerResponse, error: unknown): void => {
    console.error("MCP request failed", error);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
    else if (!res.writableEnded) res.end();
  };

  const server = createNodeServer((req, res) => {
    // A synchronous throw in this listener is an uncaught exception and kills
    // the process, so every branch stays inside this guard.
    try {
      const pathname = requestPathname(req.url);

      if (req.method === "GET" && pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;

      void routeMcp(req, res).catch((error) => failRequest(res, error));
    } catch (error) {
      failRequest(res, error);
    }
  });

  server.on("clientError", (_error: Error, socket: Socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    socket.destroy();
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(sweeper);
    await Promise.allSettled(
      [...sessions.values()].map((entry) => entry.transport.close()),
    );
    sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(httpConfig.port, httpConfig.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startHttpServer()
    .then((server) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
      console.log(`ExcaliDash MCP listening on http://0.0.0.0:${port}/mcp`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
