import {
  exportToSvg,
  exportToCanvas,
  restoreElements,
  getCommonBounds,
  FONT_FAMILY,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
window.EXCALIDRAW_ASSET_PATH = "/";
document.documentElement.style.cssText =
  "margin:0;width:100%;height:100%;overflow:hidden";
document.body.style.cssText = "margin:0;width:100%;height:100%;overflow:hidden";
const host = document.querySelector("#viewport");
let origin = [0, 0],
  bounds = null;
const paint = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
window.loadScene = async (scene) => {
  // Clear the previous caller's scene before processing the next one.
  host.replaceChildren();
  bounds = null;
  origin = [0, 0];
  const live = scene.elements.filter((e) => !e.isDeleted);
  // The CSS defines local font faces. Load the families actually used before
  // restoring text dimensions, rather than measuring with fallback fonts.
  const families = new Set(
    live.filter((e) => e.type === "text").map((e) => e.fontFamily || 1),
  );
  for (const family of families) {
    const name = Object.keys(FONT_FAMILY).find(
      (k) => FONT_FAMILY[k] === family,
    );
    if (name) await document.fonts.load(`20px "${name}"`);
  }
  await document.fonts.ready;
  if (live.length)
    await exportToCanvas({
      elements: restoreElements(live, null),
      appState: {
        viewBackgroundColor: scene.appState?.viewBackgroundColor || "#ffffff",
      },
      files: scene.files || {},
      getDimensions: () => ({ width: 1, height: 1, scale: 0.000001 }),
    });
  const elements = restoreElements(live, null, {
    refreshDimensions: true,
    repairBindings: true,
  });
  const selected = elements.map((e) => ({
    id: e.id,
    bounds: getCommonBounds([e]),
    containerId: e.containerId,
    boundElements: e.boundElements || [],
  }));
  let svg;
  if (elements.length) {
    bounds = getCommonBounds(elements);
    origin = bounds.slice(0, 2);
    svg = await exportToSvg({
      elements,
      appState: {
        viewBackgroundColor: scene.appState?.viewBackgroundColor || "#ffffff",
        exportBackground: false,
        exportWithDarkMode: false,
      },
      files: scene.files || {},
      exportPadding: 0,
    });
  } else svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.display = "block";
  svg.style.background = scene.appState?.viewBackgroundColor || "#ffffff";
  svg.setAttribute("preserveAspectRatio", "none");
  host.replaceChildren(svg);
  // SVG image decode is asynchronous; reject incomplete images rather than
  // reporting a successful but misleading screenshot.
  await Promise.all(
    [...svg.querySelectorAll("image")].map(
      (node) =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = resolve;
          image.onerror = () =>
            reject(Error("An embedded drawing image could not be decoded"));
          image.src =
            node.getAttribute("href") || node.getAttribute("xlink:href");
        }),
    ),
  );
  await document.fonts.ready;
  await paint();
  return { bounds, elements: selected };
};
window.showViewport = async ({ centerX, centerY, zoom, width, height }) => {
  const svg = host.querySelector("svg");
  if (!svg) throw Error("No scene loaded");
  const w = width / zoom,
    h = height / zoom;
  svg.setAttribute(
    "viewBox",
    `${centerX - w / 2 - origin[0]} ${centerY - h / 2 - origin[1]} ${w} ${h}`,
  );
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  await paint();
};
window.rendererReady = true;
