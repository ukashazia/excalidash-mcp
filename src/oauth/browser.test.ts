import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { fixture } from "./testing/fixture.js";

test(
  "browser: existing ExcaliDash sign-in, explicit consent, callback, and disconnect",
  { timeout: 60000 },
  async () => {
    const callbackServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<p>OAuth callback received.</p>");
    });
    await new Promise<void>((r) => callbackServer.listen(0, "127.0.0.1", r));
    const address = callbackServer.address();
    if (!address || typeof address === "string")
      throw Error("Callback unavailable");
    const callbackUri = `http://127.0.0.1:${address.port}/callback`;
    const f = await fixture(callbackUri);
    const browser = await chromium.launch({
      executablePath: process.env.MCP_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const r = await fetch(f.origin + "/mcp/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT browser test",
          redirect_uris: [callbackUri],
        }),
      });
      const { client_id } = (await r.json()) as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const q = new URLSearchParams({
        client_id,
        redirect_uri: callbackUri,
        response_type: "code",
        resource: f.origin + "/mcp",
        state: "browser-test-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 960 },
      });
      // The existing frontend owns /login in production. Simulate that separate
      // frontend here; backend session validation/CSRF/key APIs use the fixture.
      await context.route(f.origin + "/login", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<html><body><h1>ExcaliDash test login</h1><form method="post" action="/test-login"><button>Sign in as Alice</button></form></body></html>',
        }),
      );
      await context.route(f.origin + "/test-login", (route) =>
        route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "Set-Cookie":
              "excalidash-access-token=alice; Path=/; HttpOnly; SameSite=Lax",
          },
          body: "<p>Signed in. Return to the authorization tab.</p>",
        }),
      );
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("requestfailed", (r) =>
        errors.push(r.failure()?.errorText || "request failed"),
      );
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(f.origin + "/mcp/oauth/authorize?" + q);
      await page
        .getByRole("heading", { name: "Sign in to continue" })
        .waitFor();
      assert.equal(f.created.length, 0);
      const opened = context.waitForEvent("page");
      await page.getByRole("link", { name: "Sign in to ExcaliDash" }).click();
      const login = await opened;
      await login.getByRole("button", { name: "Sign in as Alice" }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page
        .getByRole("heading", { name: "Authorize drawing access" })
        .waitFor();
      await page
        .getByText("Read drawings and inspect snapshots", { exact: true })
        .waitFor();
      await page
        .getByText("Create and modify drawings", { exact: true })
        .waitFor();
      assert.equal(
        f.created.length,
        0,
        "sign-in alone must never create credentials",
      );
      if (process.env.MCP_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.MCP_TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({
          path: process.env.MCP_TEST_ARTIFACT_DIR + "/oauth-consent.png",
          fullPage: true,
        });
      }
      const consentResponse = page.waitForResponse(
        (r) => r.url() === f.origin + "/mcp/oauth/consent",
      );
      await page
        .getByRole("button", { name: "Allow access", exact: true })
        .click();
      const cr = await consentResponse;
      assert.equal(
        cr.status(),
        303,
        await cr.text().catch(() => "Consent response unavailable"),
      );
      await page
        .waitForURL((u) => u.pathname === "/callback", { timeout: 5000 })
        .catch(() => {
          throw Error(JSON.stringify(errors));
        });
      const callback = new URL(page.url());
      assert.equal(callback.searchParams.get("state"), "browser-test-state");
      assert.equal(callback.searchParams.get("iss"), f.origin + "/mcp/oauth");
      assert.equal(f.created.length, 1);
      assert.equal(f.created[0]!.user, "alice");
      const token = await fetch(f.origin + "/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          code: callback.searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: callbackUri,
          resource: f.origin + "/mcp",
        }),
      });
      assert.equal(token.status, 200, await token.clone().text());
      assert.ok(!page.url().includes(f.created[0]!.token));
      await page.goto(f.origin + "/mcp/oauth/connections");
      await page
        .getByRole("heading", { name: "ChatGPT browser test" })
        .waitFor();
      await page
        .getByRole("button", { name: "Revoke connection and key" })
        .click();
      await page.getByText("Disconnected", { exact: true }).waitFor();
      assert.ok(f.keys.get(f.created[0]!.token)!.revoked);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await f.close();
      callbackServer.closeAllConnections();
      await new Promise<void>((r) => callbackServer.close(() => r()));
    }
  },
);
