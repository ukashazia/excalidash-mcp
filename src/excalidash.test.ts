import assert from "node:assert/strict";
import test from "node:test";
import {
  configFromEnv,
  ExcaliDashClient,
  ExcaliDashError,
  type Fetch,
} from "./excalidash.js";

const config = {
  url: "https://dash.example.test/",
  token: "secret-agent-token",
  drawingId: "drawing/one",
};

test("configFromEnv requires URL and token while drawing ID is optional", () => {
  assert.deepEqual(
    configFromEnv({
      EXCALIDASH_URL: " https://dash.example.test ",
      EXCALIDASH_API_KEY: " token ",
    }),
    {
      url: "https://dash.example.test",
      token: "token",
      drawingId: undefined,
    },
  );
  assert.throws(() => configFromEnv({}), /EXCALIDASH_URL is required/);
});

test("getSummary calls the drawing-scoped Agent API with bearer auth", async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetchImpl: Fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response("Drawing: architecture", { status: 200 });
  };

  const client = new ExcaliDashClient(config, fetchImpl);
  assert.equal(
    await client.getSummary("drawing/one"),
    "Drawing: architecture",
  );
  assert.equal(
    request?.input,
    "https://dash.example.test/api/drawings/drawing%2Fone/summary",
  );
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    "Bearer secret-agent-token",
  );
});

test("applyOps forwards one atomic batch", async () => {
  let body: unknown;
  const fetchImpl: Fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ version: 2 });
  };

  const client = new ExcaliDashClient(config, fetchImpl);
  assert.deepEqual(
    await client.applyOps(
      "drawing/one",
      [{ op: "add_shape", shape: "rectangle", x: 10, y: 20 }],
      "batch-1",
    ),
    { version: 2 },
  );
  assert.deepEqual(body, {
    ops: [{ op: "add_shape", shape: "rectangle", x: 10, y: 20 }],
    clientBatchId: "batch-1",
  });
});

test("HTTP failures are bounded and never include the configured token", async () => {
  const fetchImpl: Fetch = async () =>
    new Response("x".repeat(3000), { status: 422 });
  const client = new ExcaliDashClient(config, fetchImpl);

  await assert.rejects(client.getSummary("drawing/one"), (error: unknown) => {
    assert.ok(error instanceof ExcaliDashError);
    assert.equal(error.status, 422);
    assert.ok(error.message.length < 2100);
    assert.doesNotMatch(error.message, /secret-agent-token/);
    return true;
  });
});
