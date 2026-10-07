import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

export class ViewportRenderer {
  #browser;
  #page;
  #http;
  #origin;
  #sceneKey;
  #geometry;
  #tail = Promise.resolve();
  #pending = 0;
  #launches = 0;
  constructor({
    assetDir = fileURLToPath(new URL("./renderer/", import.meta.url)),
    executablePath = process.env.MCP_CHROMIUM_EXECUTABLE,
    timeoutMs = 20000,
    maxPending = 8,
  } = {}) {
    Object.assign(this, { assetDir, executablePath, timeoutMs, maxPending });
  }
  async #start() {
    if (this.#browser?.isConnected() && this.#page && !this.#page.isClosed())
      return;
    if (!this.#http) {
      this.#http = createServer(async (req, res) => {
        try {
          const name = decodeURIComponent((req.url || "/").split("?")[0]);
          const relative = name === "/" ? "index.html" : name.slice(1);
          const file = path.resolve(this.assetDir, relative);
          if (!file.startsWith(path.resolve(this.assetDir) + path.sep)) {
            res.writeHead(404).end();
            return;
          }
          const data = await readFile(file);
          const ext = path.extname(file);
          res.setHeader(
            "Content-Type",
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".woff2": "font/woff2",
              ".svg": "image/svg+xml",
            }[ext] || "application/octet-stream",
          );
          res.end(data);
        } catch {
          res.writeHead(404).end();
        }
      });
      await new Promise((resolve) =>
        this.#http.listen(0, "127.0.0.1", resolve),
      );
      this.#http.unref();
      this.#origin = `http://127.0.0.1:${this.#http.address().port}`;
    }
    if (this.#browser?.isConnected()) await this.#browser.close();
    this.#browser = await chromium.launch({
      headless: true,
      executablePath: this.executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      timeout: this.timeoutMs,
    });
    this.#launches++;
    const context = await this.#browser.newContext({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    // Scene data has no access to backend credentials or external networking.
    await context.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(this.#origin + "/")
        ? route.continue()
        : route.abort(),
    );
    this.#page = await context.newPage();
    this.#page.setDefaultTimeout(this.timeoutMs);
    await this.#page.goto(this.#origin);
    await this.#page.waitForFunction(() => window.rendererReady);
    this.#sceneKey = undefined;
  }
  async #job(action) {
    if (this.#pending >= this.maxPending)
      throw Error("Renderer busy; retry after the pending snapshots finish.");
    this.#pending++;
    const job = this.#tail.then(async () => {
      let timer;
      try {
        await this.#start();
        return await Promise.race([
          action(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Error("Renderer request timed out; retry the snapshot."),
                ),
              this.timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        await this.#page?.close().catch(() => {});
        this.#page = undefined;
        this.#sceneKey = undefined;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    this.#tail = job.catch(() => {});
    try {
      return await job;
    } finally {
      this.#pending--;
    }
  }
  async #load(scene) {
    const key = createHash("sha256")
      .update(JSON.stringify(scene))
      .digest("hex");
    if (key !== this.#sceneKey) {
      this.#geometry = await this.#page.evaluate(
        (scene) => window.loadScene(scene),
        scene,
      );
      this.#sceneKey = key;
    }
    return this.#geometry;
  }
  geometry(scene) {
    return this.#job(() => this.#load(scene));
  }
  snapshot(scene, viewport) {
    return this.#job(async () => {
      const started = performance.now();
      const geometry = await this.#load(scene);
      await this.#page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await this.#page.evaluate(
        (viewport) => window.showViewport(viewport),
        viewport,
      );
      const png = await this.#page.screenshot({
        type: "png",
        timeout: this.timeoutMs,
      });
      if (png.length > 5 * 1024 * 1024)
        throw Error(
          "Snapshot exceeds the image response limit; use a smaller viewport.",
        );
      return {
        png,
        geometry,
        renderMs: Math.round(performance.now() - started),
      };
    });
  }
  stats() {
    return { browserLaunches: this.#launches, pending: this.#pending };
  }
  async close() {
    await this.#tail;
    await this.#browser?.close();
    if (this.#http) await new Promise((resolve) => this.#http.close(resolve));
    this.#browser = undefined;
    this.#page = undefined;
    this.#http = undefined;
  }
}
export const sharedRenderer = new ViewportRenderer();

process.once("SIGTERM", () => void sharedRenderer.close());
process.once("SIGINT", () => void sharedRenderer.close());
