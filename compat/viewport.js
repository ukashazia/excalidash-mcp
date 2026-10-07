import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { sharedRenderer } from "./renderer.js";

const number = z.number().finite();
const coordinate = number.min(-1e9).max(1e9);
const sceneSchema = z.object({
  elements: z.array(z.record(z.string(), z.unknown())).max(5000),
  appState: z.record(z.string(), z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
});
const zoomSchema = number.min(0.000001).max(32);
export function validateScene(scene) {
  if (!Array.isArray(scene.elements) || scene.elements.length > 5000)
    throw Error("Renderer requires at most 5,000 elements.");
  if (Buffer.byteLength(JSON.stringify(scene)) > 8 * 1024 * 1024)
    throw Error("Drawing exceeds the 8 MiB renderer input limit.");
  const ids = new Set();
  for (const e of scene.elements) {
    if (e.isDeleted) continue;
    if (typeof e.id !== "string" || ids.has(e.id))
      throw Error("Every visible element must have a unique ID.");
    ids.add(e.id);
    for (const field of ["x", "y", "width", "height"])
      if (!Number.isFinite(e[field]) || Math.abs(e[field]) > 1e9)
        throw Error(`Invalid ${field} on element ${e.id}.`);
    if (e.width < 0 || e.height < 0)
      throw Error(`Negative dimensions on element ${e.id}.`);
    if (e.type === "image") {
      const file = scene.files?.[e.fileId];
      if (
        !file?.dataURL ||
        !/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(
          file.dataURL,
        )
      )
        throw Error(
          `Image ${e.id} requires embedded image data in files; remote image URLs are not fetched.`,
        );
    }
  }
  return scene;
}
export function fitViewport(bounds, width = 1280, height = 960, padding = 48) {
  if (!bounds) return { centerX: 0, centerY: 0, zoom: 1, width, height };
  const [x1, y1, x2, y2] = bounds;
  const zoom = Math.min(
    32,
    (width - 2 * padding) / Math.max(x2 - x1, 1),
    (height - 2 * padding) / Math.max(y2 - y1, 1),
  );
  if (zoom < 0.000001)
    throw Error(
      "Board is too large to fit; focus on selected elements instead.",
    );
  return {
    centerX: (x1 + x2) / 2,
    centerY: (y1 + y2) / 2,
    zoom,
    width,
    height,
  };
}
export function viewportBounds(v) {
  return {
    x: v.centerX - v.width / v.zoom / 2,
    y: v.centerY - v.height / v.zoom / 2,
    width: v.width / v.zoom,
    height: v.height / v.zoom,
  };
}
export function registerViewportTools(
  server,
  client,
  resolve,
  { renderer = sharedRenderer } = {},
) {
  let state;
  let tail = Promise.resolve();
  const metadata = () =>
    state
      ? {
          drawingId: state.drawingId,
          version: state.version,
          source: state.draft ? "draft" : "saved",
          ...(state.draft ? { draftHash: state.draftHash } : {}),
          viewport: state.viewport,
          bounds: viewportBounds(state.viewport),
        }
      : { viewport: null };
  const register = (name, description, schema, action) =>
    server.registerTool(name, { description, inputSchema: schema }, (args) => {
      const run = tail.then(async () => {
        try {
          return await action(args);
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: e instanceof Error ? e.message : String(e),
              },
            ],
          };
        }
      });
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    });
  const text = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
  });
  const required = () => {
    if (!state)
      throw Error("Call set_viewport before navigating or taking a snapshot.");
    return state;
  };
  register(
    "set_viewport",
    "Set this session’s private rendering viewport. Fit the board or elementIds, or provide centerX/centerY and zoom. Optional draft previews elements without saving. Does not move the user’s browser.",
    z
      .object({
        drawingId: z.string().min(1).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
        fit: z.enum(["board", "elements"]).optional(),
        elementIds: z.array(z.string().min(1)).min(1).max(5000).optional(),
        centerX: coordinate.optional(),
        centerY: coordinate.optional(),
        zoom: zoomSchema.optional(),
        padding: number.min(0).max(300).default(48),
        draft: sceneSchema.optional(),
      })
      .refine(
        (a) =>
          a.fit
            ? ![a.centerX, a.centerY, a.zoom].some((v) => v !== undefined) &&
              (a.fit !== "elements" || a.elementIds?.length)
            : (a.centerX !== undefined &&
                a.centerY !== undefined &&
                a.zoom !== undefined) ||
              ([a.centerX, a.centerY, a.zoom].every((v) => v === undefined) &&
                !a.elementIds),
        "Use fit (with elementIds for elements) OR all of centerX, centerY, zoom.",
      ),
    async (args) => {
      const drawing = await client.getDrawing(resolve(args.drawingId));
      if (
        args.expectedVersion !== undefined &&
        drawing.version !== args.expectedVersion
      )
        throw Error(
          `Drawing version changed: expected ${args.expectedVersion}, found ${drawing.version}. Reread before inspecting.`,
        );
      const scene = validateScene(
        args.draft
          ? {
              elements: args.draft.elements,
              appState: args.draft.appState ?? drawing.appState ?? {},
              files: args.draft.files ?? drawing.files ?? {},
            }
          : {
              elements: drawing.elements,
              appState: drawing.appState || {},
              files: drawing.files || {},
            },
      );
      const geometry = await renderer.geometry(scene);
      let bounds = geometry.bounds;
      if (args.fit === "elements") {
        const ids = new Set(args.elementIds);
        for (const id of ids)
          if (!geometry.elements.some((e) => e.id === id))
            throw Error(`Element not found: ${id}`);
        for (const e of geometry.elements)
          if (ids.has(e.id)) {
            for (const child of e.boundElements) ids.add(child.id);
          }
        const selected = geometry.elements.filter(
          (e) => ids.has(e.id) || ids.has(e.containerId),
        );
        bounds = [
          Math.min(...selected.map((e) => e.bounds[0])),
          Math.min(...selected.map((e) => e.bounds[1])),
          Math.max(...selected.map((e) => e.bounds[2])),
          Math.max(...selected.map((e) => e.bounds[3])),
        ];
      }
      const viewport =
        args.centerX !== undefined
          ? {
              centerX: args.centerX,
              centerY: args.centerY,
              zoom: args.zoom,
              width: 1280,
              height: 960,
            }
          : fitViewport(bounds, 1280, 960, args.padding);
      state = {
        drawingId: drawing.id,
        version: drawing.version,
        viewport,
        ...(args.draft
          ? {
              draft: scene,
              draftHash: createHash("sha256")
                .update(JSON.stringify(scene))
                .digest("hex"),
            }
          : {}),
      };
      return text(metadata());
    },
  );
  register(
    "get_viewport",
    "Read this session’s viewport, scene source, drawing version, and exact canvas bounds.",
    z.object({}),
    async () => text(metadata()),
  );
  register(
    "pan_viewport",
    "Move this session’s viewport by dx/dy in canvas units. Positive dx moves right; positive dy moves down.",
    z.object({ dx: coordinate, dy: coordinate }),
    async ({ dx, dy }) => {
      const s = required();
      const centerX = coordinate.parse(s.viewport.centerX + dx),
        centerY = coordinate.parse(s.viewport.centerY + dy);
      s.viewport = { ...s.viewport, centerX, centerY };
      return text(metadata());
    },
  );
  register(
    "zoom_viewport",
    "Multiply viewport zoom around its current center. factor > 1 zooms in; factor < 1 zooms out. Does not change the drawing.",
    z.object({ factor: number.min(0.01).max(100) }),
    async ({ factor }) => {
      const s = required();
      s.viewport = {
        ...s.viewport,
        zoom: zoomSchema.parse(s.viewport.zoom * factor),
      };
      return text(metadata());
    },
  );
  register(
    "snapshot_viewport",
    "Return a 1280×960 PNG image of exactly this session’s viewport, plus bounds and drawing version. Saved-board snapshots fail if the board changed since set_viewport. Draft snapshots never save. Pan or zoom for readable detail.",
    z.object({}),
    async () => {
      const s = required();
      let scene = s.draft;
      if (!scene) {
        const drawing = await client.getDrawing(s.drawingId);
        if (drawing.version !== s.version)
          throw Error(
            `Drawing changed from version ${s.version} to ${drawing.version}. Call set_viewport again to refresh.`,
          );
        scene = validateScene({
          elements: drawing.elements,
          appState: drawing.appState || {},
          files: drawing.files || {},
        });
      }
      const { png, geometry, renderMs } = await renderer.snapshot(
        scene,
        s.viewport,
      );
      const b = viewportBounds(s.viewport);
      const visible = geometry.elements
        .filter(
          (e) =>
            e.bounds[2] >= b.x &&
            e.bounds[0] <= b.x + b.width &&
            e.bounds[3] >= b.y &&
            e.bounds[1] <= b.y + b.height,
        )
        .map((e) => e.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...metadata(),
              visibleElementIds: visible,
              renderMs,
              rendererVersion: "excalidraw-0.18.1",
              note: "Viewport preview from scene data; does not show unsaved edits in a user browser.",
            }),
          },
          {
            type: "image",
            mimeType: "image/png",
            data: png.toString("base64"),
          },
        ],
      };
    },
  );
}
