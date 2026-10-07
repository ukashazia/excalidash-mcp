import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerViewportTools,
  validateScene,
  fitViewport,
} from "./viewport.js";
function fixture() {
  let drawing = {
    id: "a",
    version: 4,
    elements: [
      { id: "box", type: "rectangle", x: -50, y: -30, width: 100, height: 60 },
    ],
    appState: {},
    files: {},
  };
  const tools = new Map();
  const client = {
    getDrawing: async (id) => {
      assert.equal(id, "a");
      return structuredClone(drawing);
    },
  };
  const renderer = {
    geometry: async (scene) => ({
      bounds: [-50, -30, 50, 30],
      elements: scene.elements.map((e) => ({
        id: e.id,
        bounds: [e.x, e.y, e.x + e.width, e.y + e.height],
        boundElements: [],
        containerId: null,
      })),
    }),
    snapshot: async (scene, v) => ({
      png: Buffer.from("test"),
      geometry: await renderer.geometry(scene),
      renderMs: 1,
    }),
  };
  const make = () => {
    const t = new Map();
    registerViewportTools(
      { registerTool: (n, config, call) => t.set(n, { config, call }) },
      client,
      () => "a",
      { renderer },
    );
    return async (n, args = {}) => {
      const { config, call } = t.get(n);
      return call(config.inputSchema.parse(args));
    };
  };
  return { make, change: () => drawing.version++ };
}
const value = (r) => {
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
};
test("viewport navigation is isolated, pan is in scene units, zoom preserves center, and stale snapshots fail", async () => {
  const f = fixture(),
    a = f.make(),
    b = f.make();
  assert.equal(value(await b("get_viewport")).viewport, null);
  assert.equal((await b("snapshot_viewport")).isError, true);
  let v = value(
    await a("set_viewport", { centerX: -100, centerY: 200, zoom: 2 }),
  );
  assert.deepEqual(v.bounds, { x: -420, y: -40, width: 640, height: 480 });
  v = value(await a("pan_viewport", { dx: 100, dy: -200 }));
  assert.equal(v.viewport.centerX, 0);
  assert.equal(v.viewport.centerY, 0);
  v = value(await a("zoom_viewport", { factor: 2 }));
  assert.equal(v.viewport.zoom, 4);
  const shot = await a("snapshot_viewport");
  assert.equal(shot.content[1].type, "image");
  assert.equal(value(shot).version, 4);
  assert.equal(value(await b("get_viewport")).viewport, null);
  f.change();
  assert.equal((await a("snapshot_viewport")).isError, true);
  await a("set_viewport", { fit: "board" });
  assert.equal(value(await a("snapshot_viewport")).version, 5);
});
test("draft previews do not write and remain stable when the base drawing changes", async () => {
  const f = fixture(),
    a = f.make();
  const draft = {
    elements: [
      {
        id: "draft",
        type: "rectangle",
        x: 200,
        y: 300,
        width: 100,
        height: 100,
      },
    ],
  };
  const v = value(
    await a("set_viewport", { fit: "elements", elementIds: ["draft"], draft }),
  );
  assert.equal(v.source, "draft");
  assert.equal(v.viewport.centerX, 250);
  assert.equal(v.viewport.centerY, 350);
  assert.match(v.draftHash, /^[a-f0-9]{64}$/);
  f.change();
  assert.equal(value(await a("snapshot_viewport")).source, "draft");
  assert.equal((await a("set_viewport", { expectedVersion: 4 })).isError, true);
  assert.equal(
    (await a("set_viewport", { fit: "elements", elementIds: ["missing"] }))
      .isError,
    true,
  );
});
test("invalid navigation cannot corrupt the last viewport", async () => {
  const a = fixture().make();
  await assert.rejects(() => a("set_viewport", { centerX: 0 }));
  await a("set_viewport", { centerX: 1e9, centerY: 0, zoom: 1 });
  assert.equal((await a("pan_viewport", { dx: 10, dy: 0 })).isError, true);
  assert.equal(value(await a("get_viewport")).viewport.centerX, 1e9);
});
test("renderer rejects invalid geometry and remote/missing image data, and fitting handles empty or huge boards", () => {
  assert.throws(
    () =>
      validateScene({
        elements: [{ id: "x", x: NaN, y: 0, width: 1, height: 1 }],
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateScene({
        elements: [
          {
            id: "x",
            type: "image",
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            fileId: "remote",
          },
        ],
        files: { remote: { dataURL: "https://example.com/private" } },
      }),
    /embedded/,
  );
  assert.equal(fitViewport(null).zoom, 1);
  assert.ok(fitViewport([-1e6, -1e6, 1e6, 1e6]).zoom < 0.001);
});
