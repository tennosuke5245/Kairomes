import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = new URL("../apps/extension/", import.meta.url);
const tokens = new URL("../packages/ui-tokens/", import.meta.url);
const dist = new URL("dist/", app);
await rm(dist, { force: true, recursive: true });
await mkdir(dist, { recursive: true });
await mkdir(new URL("assets/", dist), { recursive: true });
const result = await Bun.build({
  entrypoints: ["background", "sidepanel"].map((name) =>
    fileURLToPath(new URL(`src/${name}.ts`, app)),
  ),
  outdir: fileURLToPath(dist),
  target: "browser",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "Extension build failed");
await Promise.all(
  [
    "manifest.json",
    "sidepanel.html",
    "sidepanel.css",
    "mcp-panel.css",
    "assets/kairomes-k-128.png",
  ].map((file) => copyFile(new URL(file, app), new URL(file, dist))),
);
// Shared tokens and components; sidepanel.html links them before sidepanel.css.
await Promise.all(
  ["tokens.css", "components.css"].map((file) =>
    copyFile(new URL(file, tokens), new URL(file, dist)),
  ),
);
console.log("Extension built: apps/extension/dist (load unpacked in Chrome / Edge)");
