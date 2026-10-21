import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fixture } from "./testing/fixture.js";
import { hash, CredentialCipher } from "./crypto.js";

const parse = async (r: Response) => {
  const s = await r.text();
  return JSON.parse(
    s.startsWith("event:")
      ? s
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6)
      : s,
  );
};

test(
  "OAuth end to end against isolated PostgreSQL",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(),
      resource = f.origin + "/mcp";
    let seq = 0;
    const post = (
      path: string,
      data: Record<string, string>,
      cookie?: string,
    ) =>
      fetch(f.origin + path, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: f.origin,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams(data),
      });
    const register = async (
      scopes = "drawings:read drawings:write",
      name = "ChatGPT test",
    ) => {
      const r = await fetch(f.origin + "/mcp/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: name,
          redirect_uris: [f.origin + "/callback"],
          token_endpoint_auth_method: "none",
          scope: scopes,
        }),
      });
      assert.equal(r.status, 201, await r.clone().text());
      return (await r.json()) as { client_id: string };
    };
    const begin = async (
      scopes = "drawings:read drawings:write",
      user = "alice",
      client?: { client_id: string },
      name?: string,
    ) => {
      client ??= await register(scopes, name);
      const verifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: f.origin + "/callback",
        response_type: "code",
        scope: scopes,
        state: randomBytes(16).toString("hex"),
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        resource,
      });
      const start = await fetch(f.origin + "/mcp/oauth/authorize?" + query, {
        redirect: "manual",
      });
      assert.equal(start.status, 303, await start.clone().text());
      const cookie =
        start.headers.get("set-cookie")!.split(";")[0] +
        `; excalidash-access-token=${user}; excalidash-refresh-token=never-forward-this`;
      const location = start.headers.get("location")!;
      const consentPage = await fetch(f.origin + location, {
        headers: { Cookie: cookie },
      });
      const html = await consentPage.text();
      assert.equal(consentPage.status, 200, html);
      const request = /name="request" value="([^"]+)"/.exec(html)?.[1] || "";
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] || "";
      return {
        client,
        verifier,
        query,
        cookie,
        location,
        request,
        csrf,
        html,
        consentPage,
      };
    };
    const approve = async (
      p: Awaited<ReturnType<typeof begin>>,
      decision = "allow",
    ) => {
      const r = await post(
        "/mcp/oauth/consent",
        { request: p.request, csrf: p.csrf, decision },
        p.cookie,
      );
      assert.equal(r.status, 303, await r.clone().text());
      const url = new URL(r.headers.get("location")!);
      assert.equal(url.searchParams.get("state"), p.query.get("state"));
      assert.equal(url.searchParams.get("iss"), f.origin + "/mcp/oauth");
      if (decision === "allow")
        assert.ok(
          url.searchParams.get("code"),
          url.searchParams.get("error_description") ||
            url.searchParams.get("error") ||
            "Missing authorization code",
        );
      return url;
    };
    const exchange = (
      p: Awaited<ReturnType<typeof begin>>,
      code: string,
      overrides: Record<string, string> = {},
    ) =>
      post("/mcp/oauth/token", {
        grant_type: "authorization_code",
        client_id: p.client.client_id,
        code,
        redirect_uri: f.origin + "/callback",
        code_verifier: p.verifier,
        resource,
        ...overrides,
      });
    const connect = async (scopes?: string, user?: string) => {
      const p = await begin(scopes, user),
        url = await approve(p);
      const r = await exchange(p, url.searchParams.get("code")!);
      assert.equal(r.status, 200, await r.clone().text());
      const tokens = (await r.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
        token_type: string;
      };
      assert.match(tokens.access_token, /^mcp_at_/);
      assert.match(tokens.refresh_token, /^mcp_rt_/);
      assert.equal(tokens.token_type.toLowerCase(), "bearer");
      return { ...p, tokens };
    };
    const rpc = async (
      token: string | null,
      method: string,
      params: unknown = {},
      session?: string,
    ) => {
      const r = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
      });
      return {
        status: r.status,
        session: r.headers.get("mcp-session-id")!,
        body: await parse(r),
        headers: r.headers,
      };
    };
    const initialize = (token: string) =>
      rpc(token, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "oauth-test", version: "1" },
      });
    try {
      await t.test(
        "discovery, resource challenges, registration policy, and PKCE requirements",
        async () => {
          const challenge = await rpc(null, "tools/list");
          assert.equal(challenge.status, 401);
          assert.match(
            challenge.headers.get("www-authenticate")!,
            /resource_metadata=/,
          );
          const metadata = (await fetch(
            f.origin + "/.well-known/oauth-protected-resource/mcp",
          ).then((r) => r.json())) as any;
          assert.equal(metadata.resource, resource);
          const as = (await fetch(
            f.origin + "/.well-known/oauth-authorization-server/mcp/oauth",
          ).then((r) => r.json())) as any;
          assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
          assert.equal(as.authorization_response_iss_parameter_supported, true);
          assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
          const bad = await fetch(as.registration_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              redirect_uris: ["https://attacker.example/callback"],
            }),
          });
          assert.equal(bad.status, 400);
          const c = await register();
          const q = new URLSearchParams({
            client_id: c.client_id,
            redirect_uri: f.origin + "/callback",
            response_type: "code",
            state: "test",
            resource,
          });
          assert.equal(
            (
              await fetch(as.authorization_endpoint + "?" + q, {
                redirect: "manual",
              })
            ).status,
            400,
          );
          q.set("code_challenge_method", "plain");
          q.set("code_challenge", "x".repeat(43));
          assert.equal(
            (
              await fetch(as.authorization_endpoint + "?" + q, {
                redirect: "manual",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await fetch(
                as.authorization_endpoint + "?" + q + "&client_id=duplicate",
                { redirect: "manual" },
              )
            ).status,
            400,
          );
        },
      );
      await t.test(
        "login is required; denial creates no key; consent escapes client metadata",
        async () => {
          const p = await begin(undefined, "missing");
          assert.match(p.html, /Sign in to ExcaliDash/);
          assert.equal(p.request, "");
          const before = f.created.length,
            denied = await begin(
              "drawings:read",
              "alice",
              undefined,
              "<script>alert(1)</script>",
            );
          assert.ok(!denied.html.includes("<script>alert(1)</script>"));
          assert.ok(denied.html.includes("&lt;script&gt;"));
          assert.match(
            denied.consentPage.headers.get("content-security-policy")!,
            /frame-ancestors 'none'/,
          );
          const url = await approve(denied, "deny");
          assert.equal(url.searchParams.get("error"), "access_denied");
          assert.equal(f.created.length, before);
        },
      );
      await t.test(
        "consent binds browser, account, origin, CSRF, and cannot be submitted twice",
        async () => {
          const p = await begin("drawings:read");
          const fields = {
            request: p.request,
            csrf: p.csrf,
            decision: "allow",
          };
          assert.equal(
            (
              await post(
                "/mcp/oauth/consent",
                { ...fields, csrf: "bad" },
                p.cookie,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await post(
                "/mcp/oauth/consent",
                fields,
                p.cookie.replace("=alice", "=bob"),
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await post(
                "/mcp/oauth/consent",
                fields,
                "excalidash-access-token=alice",
              )
            ).status,
            400,
          );
          const evilOrigin = await fetch(f.origin + "/mcp/oauth/consent", {
            method: "POST",
            headers: {
              Cookie: p.cookie,
              Origin: "https://attacker.example",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(fields),
          });
          assert.equal(evilOrigin.status, 403);
          await approve(p);
          assert.equal(
            (await post("/mcp/oauth/consent", fields, p.cookie)).status,
            400,
          );
          assert.ok(
            f.observedCookies.every((c) => !c.includes("never-forward-this")),
          );
        },
      );
      await t.test(
        "native MCP OAuth, permissions, separate accounts, and API-key compatibility",
        async () => {
          const alice = await connect("drawings:read"),
            bob = await connect(undefined, "bob");
          const a = await initialize(alice.tokens.access_token),
            b = await initialize(bob.tokens.access_token);
          assert.equal(a.status, 200);
          assert.equal(b.status, 200);
          const tools = await rpc(
            alice.tokens.access_token,
            "tools/list",
            {},
            a.session,
          );
          assert.equal(tools.body.result.tools.length, 13);
          const writeTool = tools.body.result.tools.find(
            (tool: any) => tool.name === "update_drawing",
          );
          assert.deepEqual(writeTool.securitySchemes, [
            { type: "oauth2", scopes: ["drawings:write"] },
          ]);
          assert.deepEqual(
            writeTool._meta.securitySchemes,
            writeTool.securitySchemes,
          );
          const list = await rpc(
            alice.tokens.access_token,
            "tools/call",
            { name: "list_drawings", arguments: {} },
            a.session,
          );
          assert.equal(
            JSON.parse(list.body.result.content[0].text).drawings[0].id,
            "alice",
          );
          assert.equal(
            (await rpc(bob.tokens.access_token, "tools/list", {}, a.session))
              .status,
            403,
          );
          const denied = await rpc(
            alice.tokens.access_token,
            "tools/call",
            { name: "create_drawing", arguments: { name: "No" } },
            a.session,
          );
          assert.equal(denied.body.result.isError, true);
          assert.match(
            denied.body.result._meta["mcp/www_authenticate"][0],
            /insufficient_scope/,
          );
          const allowed = await rpc(
            bob.tokens.access_token,
            "tools/call",
            { name: "create_drawing", arguments: { name: "Yes" } },
            b.session,
          );
          assert.ok(!allowed.body.result.isError);
          const batch = await fetch(resource, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              Authorization: "Bearer " + alice.tokens.access_token,
              "mcp-session-id": a.session,
            },
            body: JSON.stringify([
              {
                jsonrpc: "2.0",
                id: 1000,
                method: "tools/call",
                params: {
                  name: "create_drawing",
                  arguments: { name: "Must not bypass scopes" },
                },
              },
            ]),
          });
          assert.equal(batch.status, 400);
          const rawKey = f.created.find((k) => k.user === "alice")!.token;
          assert.equal((await initialize(rawKey)).status, 200);
        },
      );
      await t.test(
        "codes are single-use; wrong PKCE burns the code; resource and redirect binding",
        async () => {
          const p = await begin();
          const code = (await approve(p)).searchParams.get("code")!;
          assert.equal(
            (await exchange(p, code, { resource: "https://other.example/mcp" }))
              .status,
            400,
          );
          assert.equal(
            (await exchange(p, code, { code_verifier: "wrong".repeat(12) }))
              .status,
            400,
          );
          assert.equal((await exchange(p, code)).status, 400);
          const q = await begin();
          const code2 = (await approve(q)).searchParams.get("code")!;
          assert.equal(
            (await exchange(q, code2, { redirect_uri: f.origin + "/wrong" }))
              .status,
            400,
          );
          const r = await begin();
          const code3 = (await approve(r)).searchParams.get("code")!;
          const statuses = await Promise.all([
            exchange(r, code3),
            exchange(r, code3),
          ]).then((rs) => rs.map((x) => x.status).sort());
          assert.deepEqual(statuses, [200, 400]);
        },
      );
      await t.test(
        "refresh rotates tokens, preserves MCP session identity, restricts scope, and detects replay",
        async () => {
          const c = await connect(),
            init = await initialize(c.tokens.access_token);
          const r = await post("/mcp/oauth/token", {
            client_id: c.client.client_id,
            grant_type: "refresh_token",
            refresh_token: c.tokens.refresh_token,
            resource,
            scope: "drawings:read",
          });
          assert.equal(r.status, 200, await r.clone().text());
          const next = (await r.json()) as any;
          assert.notEqual(next.refresh_token, c.tokens.refresh_token);
          assert.equal(
            (await rpc(next.access_token, "tools/list", {}, init.session))
              .status,
            200,
          );
          const denied = await rpc(
            next.access_token,
            "tools/call",
            { name: "create_drawing", arguments: { name: "No" } },
            init.session,
          );
          assert.equal(denied.body.result.isError, true);
          const elevate = await post("/mcp/oauth/token", {
            client_id: c.client.client_id,
            grant_type: "refresh_token",
            refresh_token: next.refresh_token,
            resource,
            scope: "drawings:write",
          });
          assert.equal(elevate.status, 400);
          const replay = await post("/mcp/oauth/token", {
            client_id: c.client.client_id,
            grant_type: "refresh_token",
            refresh_token: c.tokens.refresh_token,
            resource,
          });
          assert.equal(replay.status, 400);
          assert.equal((await initialize(next.access_token)).status, 401);
        },
      );
      await t.test(
        "expiry, ciphertext authenticity, and no raw tokens in PostgreSQL",
        async () => {
          const c = await connect();
          const entry = await f.store.get(
            "access",
            hash(c.tokens.access_token),
          );
          assert.ok(entry);
          await f.store.put(
            "access",
            hash(c.tokens.access_token),
            { ...entry, expiresAt: Date.now() - 1 },
            Date.now() + 60000,
          );
          assert.equal((await initialize(c.tokens.access_token)).status, 401);
          const grants = await f.store.list("grant");
          const serialized = JSON.stringify(grants);
          assert.ok(!serialized.includes(f.created.at(-1)!.token));
          assert.ok(
            !JSON.stringify(await f.store.list("refresh")).includes(
              c.tokens.refresh_token,
            ),
          );
          assert.ok(
            !JSON.stringify(await f.store.list("code")).includes("mcp_code_"),
          );
          const cipher = new CredentialCipher(f.env.MCP_OAUTH_ENCRYPTION_KEY),
            encrypted = cipher.seal("secret", "grant-one");
          assert.throws(() => cipher.open(encrypted, "grant-two"));
          assert.throws(() =>
            cipher.open(encrypted.slice(0, -5) + "xxxxx", "grant-one"),
          );
        },
      );
      await t.test(
        "grants survive adapter restart; expired token rows are pruned",
        async () => {
          const c = await connect();
          await f.store.put("test-expired", "expired", {}, Date.now() - 1000);
          await f.restart();
          assert.equal((await initialize(c.tokens.access_token)).status, 200);
          const r = await post("/mcp/oauth/token", {
            client_id: c.client.client_id,
            grant_type: "refresh_token",
            refresh_token: c.tokens.refresh_token,
            resource,
          });
          assert.equal(r.status, 200);
          await f.store.prune();
          assert.equal(await f.store.get("test-expired", "expired"), null);
        },
      );
      await t.test(
        "key revocation, OAuth revocation and backend outages fail closed",
        async () => {
          const c = await connect();
          f.keys.get(f.created.at(-1)!.token)!.revoked = true;
          assert.equal((await initialize(c.tokens.access_token)).status, 401);
          const r = await post("/mcp/oauth/token", {
            client_id: c.client.client_id,
            grant_type: "refresh_token",
            refresh_token: c.tokens.refresh_token,
            resource,
          });
          assert.equal(r.status, 400);
          const d = await connect();
          assert.equal(
            (
              await post("/mcp/oauth/revoke", {
                client_id: d.client.client_id,
                token: d.tokens.refresh_token,
              })
            ).status,
            200,
          );
          assert.equal((await initialize(d.tokens.access_token)).status, 401);
          assert.equal(
            (
              await post("/mcp/oauth/revoke", {
                client_id: d.client.client_id,
                token: "unknown",
              })
            ).status,
            200,
          );
          const e = await connect();
          f.setUnavailable(true);
          assert.equal((await initialize(e.tokens.access_token)).status, 503);
          f.setUnavailable(false);
          assert.equal((await initialize(e.tokens.access_token)).status, 200);
        },
      );
      await t.test(
        "management page revokes only the signed-in user’s connection and dedicated key",
        async () => {
          const c = await connect(),
            d = await connect(undefined, "bob");
          const r = await fetch(f.origin + "/mcp/oauth/connections", {
            headers: { Cookie: c.cookie },
          });
          const html = await r.text();
          const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
          const aliceGrant = (await f.store.list("grant", "alice")).find(
            (g) => g.encryptedKey && g.keyId === f.created.at(-2)!.id,
          )!;
          const bobGrant = (await f.store.list("grant", "bob")).find(
            (g) => g.keyId === f.created.at(-1)!.id,
          )!;
          assert.equal(
            (
              await post(
                "/mcp/oauth/connections",
                { grant: bobGrant.id, csrf },
                c.cookie,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await post(
                "/mcp/oauth/connections",
                { grant: aliceGrant.id, csrf },
                c.cookie,
              )
            ).status,
            303,
          );
          assert.equal((await initialize(c.tokens.access_token)).status, 401);
          assert.equal((await initialize(d.tokens.access_token)).status, 200);
          assert.ok(f.keys.get(f.created.at(-2)!.token)!.revoked);
        },
      );
    } finally {
      await f.close();
    }
  },
);
