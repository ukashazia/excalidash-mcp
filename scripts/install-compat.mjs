import { cp, readdir } from "node:fs/promises";
for (const file of await readdir("compat"))
  if (file.endsWith(".js")) await cp("compat/" + file, "dist/" + file);
await cp(
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  "dist/renderer/fonts",
  { recursive: true },
);
