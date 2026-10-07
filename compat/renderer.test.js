import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { ViewportRenderer } from "./renderer.js";
const rect = (id, x, y, w, h, fill) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
  angle: 0,
  strokeColor: fill,
  backgroundColor: fill,
  fillStyle: "solid",
  strokeWidth: 1,
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});
const pixel = (png, x, y) =>
  Array.from(
    png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 3),
  );
test("real renderer keeps detail on a huge board, clips crossing objects, reuses browser, and clears prior scenes", async () => {
  const r = new ViewportRenderer();
  try {
    const elements = [
      rect("near", -100, -100, 200, 200, "#ff0000"),
      rect("far", 1e6, 1e6, 200, 200, "#0000ff"),
    ];
    const text = {
      ...rect("text", -90, -80, 10, 10, "#000000"),
      type: "text",
      text: "Readable detail",
      originalText: "Readable detail",
      fontSize: 24,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    };
    const scene = {
      elements: [...elements, text],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const geom = await r.geometry(scene);
    assert.ok(geom.bounds[2] > 1e6);
    assert.ok(
      geom.elements.find((e) => e.id === "text").bounds[2] > -80,
      "font dimensions must be restored",
    );
    const viewport = {
      centerX: 0,
      centerY: 0,
      zoom: 1,
      width: 1280,
      height: 960,
    };
    let shot = await r.snapshot(scene, viewport),
      png = PNG.sync.read(shot.png);
    assert.equal(png.width, 1280);
    assert.equal(png.height, 960);
    assert.deepEqual(pixel(png, 640, 480), [255, 0, 0]);
    assert.deepEqual(pixel(png, 800, 480), [255, 255, 255]);
    shot = await r.snapshot(scene, {
      ...viewport,
      centerX: 1000100,
      centerY: 1000100,
      zoom: 2,
    });
    png = PNG.sync.read(shot.png);
    assert.deepEqual(pixel(png, 640, 480), [0, 0, 255]);
    // The viewport cuts across the red rectangle, including its center outside the viewport.
    shot = await r.snapshot(scene, { ...viewport, centerX: 650 });
    png = PNG.sync.read(shot.png);
    assert.deepEqual(pixel(png, 10, 480), [255, 0, 0]);
    shot = await r.snapshot(
      { elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} },
      viewport,
    );
    png = PNG.sync.read(shot.png);
    assert.deepEqual(pixel(png, 640, 480), [255, 255, 255]);
    assert.equal(r.stats().browserLaunches, 1);
    console.log("Warm snapshots (ms):", shot.renderMs);
    await assert.rejects(() => r.geometry({ elements: null }), /filter/);
    await r.snapshot({ elements: [], appState: {}, files: {} }, viewport);
    assert.equal(
      r.stats().browserLaunches,
      2,
      "failed pages must recover on the next request",
    );
  } finally {
    await r.close();
  }
});
test("renderer fits rotated geometry and decodes embedded images", async () => {
  const r = new ViewportRenderer();
  try {
    const imageData = new PNG({ width: 2, height: 2 });
    imageData.data.fill(255);
    for (let i = 0; i < 16; i += 4) {
      imageData.data[i] = 0;
      imageData.data[i + 1] = 255;
      imageData.data[i + 2] = 0;
    }
    const scene = {
      elements: [
        { ...rect("rotated", 0, 0, 100, 100, "#ff0000"), angle: Math.PI / 4 },
        {
          ...rect("image", 200, 0, 100, 100, "#000000"),
          type: "image",
          fileId: "green",
          scale: [1, 1],
          status: "saved",
        },
      ],
      files: {
        green: {
          id: "green",
          mimeType: "image/png",
          dataURL:
            "data:image/png;base64," +
            PNG.sync.write(imageData).toString("base64"),
          created: 1,
        },
      },
      appState: { viewBackgroundColor: "#ffffff" },
    };
    const geom = await r.geometry(scene);
    assert.ok(geom.elements[0].bounds[0] < 0);
    const shot = await r.snapshot(scene, {
      centerX: 250,
      centerY: 50,
      zoom: 2,
      width: 1280,
      height: 960,
    });
    assert.deepEqual(pixel(PNG.sync.read(shot.png), 640, 480), [0, 255, 0]);
  } finally {
    await r.close();
  }
});
