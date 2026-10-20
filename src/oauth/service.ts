import OAuth2Server from "@node-oauth/oauth2-server";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod/v4";
import { CredentialCipher, equal, hash, randomToken } from "./crypto.js";
import {
  grant,
  oauthServer,
  pendingMs,
  GRANT_MS,
  SCOPES,
  revokeGrant,
} from "./model.js";
import { escape, page, loginBody, loginScript } from "./pages.js";
import {
  cookies,
  ExcaliDashAccounts,
  UpstreamError,
  type User,
} from "./upstream.js";
import { PgOAuthStore, type OAuthStore, type Entry } from "./store.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly oauthError = "invalid_request",
  ) {
    super(message);
  }
}
export type OAuthIdentity = {
  backendKey: string;
  binding: string;
  scopes: string[];
  userId: string;
};
const AUTHORIZE = "/mcp/oauth/authorize";
const LIMIT = 16 * 1024;
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = Buffer.from(c);
    size += b.length;
    if (size > LIMIT) throw new HttpError(413, "Request too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString();
}
function params(input: string) {
  const search = new URLSearchParams(input),
    result: Record<string, string> = Object.create(null);
  for (const [k, v] of search) {
    if (Object.hasOwn(result, k))
      throw new HttpError(400, "Duplicate parameter");
    result[k] = v;
  }
  return result;
}
const scope = (value: string) => {
  const scopes = [...new Set(value.split(" ").filter(Boolean))];
  if (!scopes.length || scopes.some((s) => !SCOPES.includes(s)))
    throw new HttpError(400, "Unsupported permissions", "invalid_scope");
  return scopes;
};
const registration = z.object({
  client_name: z.string().trim().min(1).max(80).default("MCP client"),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
  scope: z.string().max(200).optional(),
});

export class OAuthService {
  readonly origin: string;
  readonly issuer: string;
  readonly resource: string;
  readonly metadataUrl: string;
  readonly cipher: CredentialCipher;
  readonly store: OAuthStore;
  readonly accounts: ExcaliDashAccounts;
  private allowedRedirects: Set<string>;
  private browserCookie: string;
  private secure: boolean;
  private limits = new Map<string, { count: number; end: number }>();
  private sweeper?: NodeJS.Timeout;
  constructor(env: NodeJS.ProcessEnv, store?: OAuthStore) {
    const url = new URL(env.MCP_PUBLIC_URL || "");
    if (
      url.pathname !== "/mcp" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname))
      )
    )
      throw Error(
        "MCP_PUBLIC_URL must be an HTTPS /mcp URL (HTTP is allowed only on loopback for development)",
      );
    this.origin = url.origin;
    this.resource = url.href;
    this.issuer = this.origin + "/mcp/oauth";
    this.metadataUrl =
      this.origin + "/.well-known/oauth-protected-resource/mcp";
    this.secure = url.protocol === "https:";
    this.browserCookie = this.secure
      ? "__Host-excalidash-mcp-oauth"
      : "excalidash-mcp-oauth";
    this.cipher = new CredentialCipher(env.MCP_OAUTH_ENCRYPTION_KEY || "");
    if (!store && !env.MCP_OAUTH_DATABASE_URL)
      throw Error("MCP_OAUTH_DATABASE_URL is required for OAuth");
    this.store = store ?? new PgOAuthStore(env.MCP_OAUTH_DATABASE_URL!);
    this.accounts = new ExcaliDashAccounts(
      env.EXCALIDASH_URL!,
      this.origin,
      env.EXCALIDASH_PROXY_PROTO === "https" ? "https" : undefined,
    );
    this.allowedRedirects = new Set(
      (env.MCP_OAUTH_REDIRECT_URIS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const uri of this.allowedRedirects) {
      const r = new URL(uri);
      if (
        r.hash ||
        r.username ||
        r.password ||
        !(
          r.protocol === "https:" ||
          (r.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(r.hostname))
        )
      )
        throw Error("Invalid MCP_OAUTH_REDIRECT_URIS");
    }
  }
  async initialize() {
    await this.store.initialize();
    this.sweeper = setInterval(
      () =>
        void this.store
          .prune()
          .catch(() => console.error("OAuth storage cleanup failed")),
      60_000,
    );
    this.sweeper.unref();
  }
  async close() {
    clearInterval(this.sweeper);
    await this.store.close();
  }
  challenge(error?: string, required?: string) {
    return `Bearer resource_metadata="${this.metadataUrl}"${error ? `, error="${error}", error_description="Reconnect to authorize this request"` : ""}${required ? `, scope="${required}"` : ""}`;
  }
  private headers(res: ServerResponse) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "strict-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
  }
  private json(res: ServerResponse, value: unknown, status = 200) {
    this.headers(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  }
  private html(
    res: ServerResponse,
    title: string,
    content: string,
    script = "",
    status = 200,
    callbackOrigin?: string,
  ) {
    this.headers(res);
    const p = page(title, content, script, callbackOrigin);
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": p.csp,
    });
    res.end(p.html);
  }
  private redirect(res: ServerResponse, url: string) {
    this.headers(res);
    res.writeHead(303, { Location: url });
    res.end();
  }
  private browser(
    req: IncomingMessage,
    res: ServerResponse,
    create = false,
  ): string {
    let value = cookies(req)[this.browserCookie];
    if (value && !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new HttpError(400, "Invalid authorization session");
    if (!value && create) {
      value = randomToken();
      res.setHeader(
        "Set-Cookie",
        `${this.browserCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${this.secure ? "; Secure" : ""}`,
      );
    }
    if (!value)
      throw new HttpError(400, "Authorization session expired. Connect again.");
    return value;
  }
  private sameOrigin(req: IncomingMessage) {
    if (req.headers.origin !== this.origin)
      throw new HttpError(403, "Invalid request origin");
  }
  private rate(name: string, max: number) {
    const now = Date.now(),
      bucket = this.limits.get(name);
    if (!bucket || now >= bucket.end)
      this.limits.set(name, { count: 1, end: now + 60_000 });
    else if (++bucket.count > max)
      throw new HttpError(
        429,
        "Too many requests; retry shortly",
        "temporarily_unavailable",
      );
  }
  private validRedirect(uri: string) {
    if (this.allowedRedirects.has(uri)) return true;
    const u = new URL(uri);
    return (
      u.origin === "https://chatgpt.com" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      (u.pathname === "/connector_platform_oauth_redirect" ||
        /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname))
    );
  }
  private async form(req: IncomingMessage) {
    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !==
      "application/x-www-form-urlencoded"
    )
      throw new HttpError(415, "Use form-encoded requests");
    return params(await body(req));
  }
  private async pending(req: IncomingMessage, res: ServerResponse, id: string) {
    const p = await this.store.get("pending", id);
    if (!p || !equal(p.browserHash, hash(this.browser(req, res))))
      throw new HttpError(400, "Authorization request expired. Connect again.");
    return p;
  }
  private async register(req: IncomingMessage, res: ServerResponse) {
    this.rate("register", 20);
    if (
      req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    )
      throw new HttpError(415, "Use JSON registration");
    const c = registration.parse(JSON.parse(await body(req)));
    if (
      c.redirect_uris.some((uri) => !this.validRedirect(uri)) ||
      !c.grant_types.includes("authorization_code") ||
      !c.response_types.length
    )
      throw new HttpError(
        400,
        "Unsupported client metadata",
        "invalid_client_metadata",
      );
    if (c.scope) scope(c.scope);
    if ((await this.store.list("client")).length >= 1000)
      throw new HttpError(429, "Client registration limit reached");
    const client_id = randomToken("mcp_client_");
    const data = {
      ...c,
      scope: c.scope || SCOPES.join(" "),
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    // Client identities remain valid while connections use them; token lifetimes are separate.
    await this.store.put("client", client_id, data, Date.UTC(9999, 0, 1));
    this.json(res, data, 201);
  }
  private async authorize(
    req: IncomingMessage,
    res: ServerResponse,
    query: Record<string, string>,
  ) {
    this.rate("authorize", 120);
    if (query.request) {
      const p = await this.pending(req, res, query.request);
      const user = await this.accounts.user(req);
      if (!user) {
        this.html(res, "Sign in to continue", loginBody, loginScript);
        return;
      }
      if (p.userId && p.userId !== user.id)
        throw new HttpError(
          409,
          "Your account changed. Start the connection again.",
        );
      await this.store.put(
        "pending",
        p.id,
        { ...p, userId: user.id },
        p.expiresAt,
      );
      const c = await this.store.get("client", p.query.client_id);
      if (!c) throw new HttpError(400, "Client is no longer available");
      const csrf = this.cipher.csrf(
        this.browser(req, res),
        p.id + "\0" + user.id,
      );
      const labels: Record<string, string> = {
        "drawings:read": "Read drawings and inspect snapshots",
        "drawings:write": "Create and modify drawings",
      };
      this.html(
        res,
        "Authorize drawing access",
        `<p><strong>${escape(c.client_name)}</strong> is requesting access to ExcaliDash.</p><div class="account">Signed in as <strong>${escape(user.name || user.email || user.id)}</strong></div><ul>${p.scopes.map((s: string) => `<li>${escape(labels[s])}</li>`).join("")}</ul><p><small>Only approve a connection you started. Application names are supplied by the connecting client.</small></p><form method="post" action="/mcp/oauth/consent"><input type="hidden" name="request" value="${escape(p.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="allow">Allow access</button><button class="secondary" name="decision" value="deny">Cancel</button></form><p><small>A dedicated API key will be created for this connection. Manage access in <a href="/mcp/oauth/connections">MCP connections</a> or ExcaliDash API Keys.</small></p>`,
        "",
        200,
        new URL(p.query.redirect_uri).origin,
      );
      return;
    }
    if (
      Object.keys(query).some(
        (k) =>
          ![
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "state",
            "code_challenge",
            "code_challenge_method",
            "resource",
          ].includes(k),
      )
    )
      throw new HttpError(400, "Unsupported authorization parameter");
    const c = await this.store.get("client", query.client_id || "");
    if (!c || !c.redirect_uris.includes(query.redirect_uri))
      throw new HttpError(400, "Invalid client or redirect URI");
    if (
      query.response_type !== "code" ||
      query.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || "") ||
      !query.state ||
      query.state.length > 2048 ||
      query.resource !== this.resource
    )
      throw new HttpError(
        400,
        "Authorization requires code, state, PKCE S256, and the advertised resource",
      );
    const scopes = scope(query.scope || c.scope);
    if (scopes.some((s) => !scope(c.scope).includes(s)))
      throw new HttpError(
        400,
        "Client cannot request these scopes",
        "invalid_scope",
      );
    if ((await this.store.list("pending")).length >= 1000)
      throw new HttpError(429, "Too many pending authorization requests");
    const browser = this.browser(req, res, true),
      id = randomToken(),
      expiresAt = Date.now() + pendingMs;
    await this.store.put(
      "pending",
      id,
      {
        id,
        query: { ...query, scope: scopes.join(" ") },
        scopes,
        browserHash: hash(browser),
        expiresAt,
      },
      expiresAt,
    );
    this.redirect(res, AUTHORIZE + "?request=" + id);
  }
  private callback(p: Entry, error: string) {
    const u = new URL(p.query.redirect_uri);
    u.searchParams.set("error", error);
    u.searchParams.set("state", p.query.state);
    u.searchParams.set("iss", this.issuer);
    return u.href;
  }
  private async consent(req: IncomingMessage, res: ServerResponse) {
    this.sameOrigin(req);
    this.rate("consent", 30);
    const f = await this.form(req),
      p = await this.pending(req, res, f.request || "");
    const user = await this.accounts.user(req);
    if (
      !user ||
      user.id !== p.userId ||
      !equal(
        f.csrf || "",
        this.cipher.csrf(this.browser(req, res), p.id + "\0" + user.id),
      )
    )
      throw new HttpError(
        403,
        "Sign-in changed or consent expired. Connect again.",
      );
    if (!["allow", "deny"].includes(f.decision || ""))
      throw new HttpError(400, "Invalid consent decision");
    // Claim atomically before issuing a key. Double clicks cannot create duplicate credentials.
    if (!(await this.store.remove("pending", p.id)))
      throw new HttpError(400, "Authorization already completed");
    if (f.decision === "deny") {
      this.redirect(res, this.callback(p, "access_denied"));
      return;
    }
    if (
      (await this.store.list("grant", user.id)).filter((g) => !g.revokedAt)
        .length >= 50
    )
      throw new HttpError(
        409,
        "Revoke an old MCP connection before adding another",
      );
    const c = await this.store.get("client", p.query.client_id);
    if (!c) throw new HttpError(400, "Client is unavailable");
    const key = await this.accounts.createKey(
      req,
      ("MCP: " + c.client_name).slice(0, 100),
      p.scopes,
    );
    const id = randomToken(),
      expiresAt = Date.now() + GRANT_MS;
    try {
      const location = await this.store.transaction(async (repo) => {
        await repo.put(
          "grant",
          id,
          {
            id,
            userId: user.id,
            profile: user,
            clientId: c.client_id,
            clientName: c.client_name,
            scopes: p.scopes,
            keyId: key.id,
            encryptedKey: this.cipher.seal(key.token, id),
            createdAt: Date.now(),
            expiresAt,
          },
          expiresAt,
        );
        const oauth = oauthServer(repo, this.resource),
          response = new OAuth2Server.Response();
        await oauth.authorize(
          new OAuth2Server.Request({
            method: "GET",
            headers: {},
            query: p.query,
            body: {},
          }),
          response,
          { authenticateHandler: { handle: async () => ({ grantId: id }) } },
        );
        const location = new URL(response.headers!.location!);
        location.searchParams.set("iss", this.issuer);
        return location.href;
      });
      this.redirect(res, location);
    } catch (e) {
      await this.accounts.revokeKey(req, key.id).catch(() => {});
      throw e;
    }
  }
  private async token(req: IncomingMessage, res: ServerResponse) {
    this.rate("token", 240);
    const f = await this.form(req);
    if (f.resource !== this.resource)
      throw new HttpError(
        400,
        "Token resource does not match the MCP server",
        "invalid_target",
      );
    if (
      !["authorization_code", "refresh_token"].includes(f.grant_type || "") ||
      !f.client_id ||
      f.client_secret ||
      req.headers.authorization ||
      Object.keys(f).some(
        (k) =>
          ![
            "grant_type",
            "client_id",
            "code",
            "redirect_uri",
            "code_verifier",
            "refresh_token",
            "scope",
            "resource",
          ].includes(k),
      )
    )
      throw new HttpError(
        400,
        "Only public authorization-code and refresh-token grants are supported",
      );
    if (f.grant_type === "refresh_token") {
      const t = await this.store.get("refresh", hash(f.refresh_token || ""));
      const g =
        t?.clientId === f.client_id ? await grant(this.store, t.grantId) : null;
      if (
        g &&
        !(await this.accounts.keyValid(this.cipher.open(g.encryptedKey, g.id)))
      ) {
        await revokeGrant(this.store, g);
        throw new HttpError(
          400,
          "ExcaliDash access was revoked",
          "invalid_grant",
        );
      }
    }
    const result = await this.store.transaction(async (repo) => {
      const response = new OAuth2Server.Response();
      try {
        await oauthServer(repo, this.resource, f.client_id).token(
          new OAuth2Server.Request({
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "content-length": String(
                Buffer.byteLength(new URLSearchParams(f).toString()),
              ),
            },
            query: {},
            body: f,
          }),
          response,
        );
        return { status: response.status!, body: response.body };
      } catch (e) {
        // Commit consumed codes/replayed-token revocations even when the OAuth exchange fails.
        if (e instanceof OAuth2Server.OAuthError && e.code < 500)
          return {
            status: e.code,
            body: response.body?.error
              ? response.body
              : { error: e.name, error_description: e.message },
          };
        throw e;
      }
    });
    this.json(res, result.body, result.status);
  }
  async authenticate(value: string): Promise<OAuthIdentity | null> {
    if (!/^mcp_at_[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const t = await this.store.get("access", hash(value));
    if (!t || t.resource !== this.resource || t.expiresAt <= Date.now())
      return null;
    const g = await grant(this.store, t.grantId);
    if (!g || g.clientId !== t.clientId) return null;
    const backendKey = this.cipher.open(g.encryptedKey, g.id);
    if (!(await this.accounts.keyValid(backendKey))) {
      await revokeGrant(this.store, g);
      return null;
    }
    return {
      backendKey,
      binding: "oauth:" + g.id,
      scopes: t.scope,
      userId: g.userId,
    };
  }
  private async revoke(req: IncomingMessage, res: ServerResponse) {
    this.rate("revoke", 120);
    const f = await this.form(req);
    if (!f.client_id || req.headers.authorization || f.client_secret)
      throw new HttpError(400, "Public client_id is required");
    for (const kind of ["access", "refresh"]) {
      const t = await this.store.get(kind, hash(f.token || ""));
      if (t?.clientId === f.client_id) {
        const g = await grant(this.store, t.grantId);
        if (g) await revokeGrant(this.store, g);
      }
    }
    this.json(res, {});
  }
  private async connections(req: IncomingMessage, res: ServerResponse) {
    const user = await this.accounts.user(req);
    if (!user) {
      this.html(res, "Sign in to manage access", loginBody, loginScript);
      return;
    }
    const browser = this.browser(req, res, true);
    const csrf = this.cipher.csrf(browser, "connections\0" + user.id);
    if (req.method === "POST") {
      this.sameOrigin(req);
      const f = await this.form(req);
      if (!equal(f.csrf || "", csrf))
        throw new HttpError(403, "Invalid management request");
      const g = await this.store.get("grant", f.grant || "");
      if (!g || g.userId !== user.id)
        throw new HttpError(404, "Connection not found");
      // Stop OAuth access first; retain keyId for a retriable upstream revocation.
      await revokeGrant(this.store, g);
      await this.accounts.revokeKey(req, g.keyId);
      this.redirect(res, "/mcp/oauth/connections");
      return;
    }
    const grants = await this.store.list("grant", user.id);
    this.html(
      res,
      "MCP connections",
      `<p>Manage applications connected to your drawings.</p>${grants.length ? grants.map((g) => `<div class="connection"><h2>${escape(g.clientName)}</h2><p>${escape(g.scopes.join(", "))}</p><small>${g.revokedAt ? "Disconnected" : "Expires " + escape(new Date(g.expiresAt).toISOString().slice(0, 10))}</small><form method="post"><input type="hidden" name="grant" value="${escape(g.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button class="secondary">Revoke connection and key</button></form></div>`).join("") : "<p>No connections yet.</p>"}`,
    );
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const u = new URL(req.url || "/", this.origin),
        path = u.pathname;
      if (
        req.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].includes(path)
      ) {
        this.json(res, {
          resource: this.resource,
          authorization_servers: [this.issuer],
          scopes_supported: SCOPES,
          bearer_methods_supported: ["header"],
        });
        return;
      }
      if (
        req.method === "GET" &&
        [
          "/.well-known/oauth-authorization-server",
          "/.well-known/oauth-authorization-server/mcp/oauth",
        ].includes(path)
      ) {
        this.json(res, {
          issuer: this.issuer,
          authorization_endpoint: this.origin + AUTHORIZE,
          token_endpoint: this.issuer + "/token",
          registration_endpoint: this.issuer + "/register",
          revocation_endpoint: this.issuer + "/revoke",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          revocation_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: SCOPES,
          authorization_response_iss_parameter_supported: true,
        });
        return;
      }
      if (path === "/mcp/oauth/register" && req.method === "POST")
        return await this.register(req, res);
      if (path === AUTHORIZE && req.method === "GET")
        return await this.authorize(req, res, params(u.search.slice(1)));
      if (path === "/mcp/oauth/consent" && req.method === "POST")
        return await this.consent(req, res);
      if (path === "/mcp/oauth/token" && req.method === "POST")
        return await this.token(req, res);
      if (path === "/mcp/oauth/revoke" && req.method === "POST")
        return await this.revoke(req, res);
      if (
        path === "/mcp/oauth/connections" &&
        ["GET", "POST"].includes(req.method || "")
      )
        return await this.connections(req, res);
      if (path === "/mcp/oauth/session" && req.method === "GET") {
        this.json(res, {
          authenticated: Boolean(await this.accounts.user(req)),
        });
        return;
      }
      this.json(res, { error: "not_found" }, 404);
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError)
        this.json(
          res,
          { error: e.oauthError, error_description: e.message },
          e.status,
        );
      else if (e instanceof UpstreamError)
        this.json(
          res,
          {
            error: "temporarily_unavailable",
            error_description: "ExcaliDash account access is unavailable",
          },
          e.status,
        );
      else if (
        e instanceof z.ZodError ||
        e instanceof SyntaxError ||
        e instanceof TypeError
      )
        this.json(
          res,
          {
            error: "invalid_request",
            error_description: "Invalid request parameters",
          },
          400,
        );
      else
        this.json(
          res,
          {
            error: "temporarily_unavailable",
            error_description: "Authorization is unavailable. Retry shortly.",
          },
          503,
        );
    }
  }
}
