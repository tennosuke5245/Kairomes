import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { uiCss } from "../packages/ui-tokens/index.ts";

const app = new URL("../apps/widget/", import.meta.url);
async function bundle(entrypoint: string) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entrypoint, app))],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const output = result.outputs[0];
  if (!output) throw new Error(`Widget build produced no output for ${entrypoint}`);
  return (await output.text()).replace(/<\/script/gi, "<\\/script");
}
const script = await bundle("src/main.tsx");
const resultScript = await bundle("src/mcp-result.ts");
const logo = (await readFile(new URL("assets/kairomes-k-128.png", app))).toString("base64");
// Shared tokens and components come first; each surface stylesheet builds on them.
const css = `:root{--kairomes-logo:url("data:image/png;base64,${logo}")}\n${uiCss}\n${await readFile(new URL("node_modules/@xterm/xterm/css/xterm.css", app), "utf8")}\n${await readFile(new URL("src/styles.css", app), "utf8")}`;
const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kairomes · 本機工作台</title><!--KAIROMES_MODE--><style>${css}</style></head>
<body><div id="root"></div><script type="module">${script}</script></body></html>`;
const resultCss = `:root{--kairomes-logo:url("data:image/png;base64,${logo}")}\n${uiCss}\n${await readFile(new URL("src/mcp-result.css", app), "utf8")}`;
const resultHtml = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kairomes · MCP Result</title><style>${resultCss}</style></head>
<body><div id="root"></div><script type="module">${resultScript}</script></body></html>`;
await mkdir(new URL("dist/", app), { recursive: true });
await writeFile(new URL("dist/workbench.html", app), html);
await writeFile(new URL("dist/mcp-result.html", app), resultHtml);
console.log(
  `Widgets built: workbench ${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, MCP result ${(Buffer.byteLength(resultHtml) / 1024).toFixed(1)} KiB`,
);
