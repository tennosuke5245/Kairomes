import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const binaries = path.join(root, "apps", "desktop", "src-tauri", "binaries");
const resources = path.join(binaries, "resources");

const host = Bun.spawn(["rustc", "--print", "host-tuple"], {
  cwd: root,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "inherit",
});
const target = (await new Response(host.stdout).text()).trim();
if ((await host.exited) !== 0 || !target) throw new Error("Unable to resolve the Rust host tuple");

const extension = process.platform === "win32" ? ".exe" : "";
const executable = path.join(binaries, `kairomes-runtime-${target}${extension}`);
await mkdir(resources, { recursive: true });
await rm(executable, { force: true });

const args = [
  process.execPath,
  "build",
  "--compile",
  `--outfile=${executable}`,
  ...(process.platform === "win32"
    ? [
        "--windows-hide-console",
        "--windows-title=Kairomes Runtime",
        "--windows-version=0.1.2.0",
        "--windows-description=Kairomes local MCP runtime",
      ]
    : []),
  path.join(root, "apps", "cli", "src", "companion-main.ts"),
];
const build = Bun.spawn(args, {
  cwd: root,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) throw new Error("Kairomes desktop sidecar build failed");

await Promise.all([
  copyFile(
    path.join(root, "apps", "widget", "dist", "workbench.html"),
    path.join(resources, "workbench.html"),
  ),
  copyFile(
    path.join(root, "apps", "widget", "dist", "mcp-result.html"),
    path.join(resources, "mcp-result.html"),
  ),
  copyFile(
    path.join(root, "apps", "extension", "assets", "kairomes-k-128.png"),
    path.join(resources, "kairomes-k-128.png"),
  ),
]);

console.log(`Desktop sidecar: ${executable}`);
