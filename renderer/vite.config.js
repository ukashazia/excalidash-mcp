import { defineConfig } from "vite";
export default defineConfig({
  root: "renderer",
  build: { outDir: "../dist/renderer", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
