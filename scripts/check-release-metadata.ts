import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function readJson(relativePath: string): Promise<{ version?: unknown }> {
  const content = await readFile(path.join(root, relativePath), "utf8");
  return JSON.parse(content) as { version?: unknown };
}

const rootManifest = await readJson("package.json");
if (typeof rootManifest.version !== "string" || !rootManifest.version) {
  throw new Error("package.json is missing a version");
}

const versions = new Map<string, string>();
const extensionPath = path.join("apps", "extension", "package.json");
let extensionVersion: string | undefined;
for (const parent of ["apps", "packages"]) {
  for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(parent, entry.name, "package.json");
    const manifest = await readJson(manifestPath);
    if (typeof manifest.version !== "string" || !manifest.version)
      throw new Error(`${manifestPath} is missing a version`);
    if (manifestPath === extensionPath) extensionVersion = manifest.version;
    else versions.set(manifestPath, manifest.version);
  }
}

const extensionManifest = await readJson(path.join("apps", "extension", "manifest.json"));
if (!extensionVersion || extensionManifest.version !== extensionVersion)
  throw new Error("Extension package and browser manifest versions do not match");
if (!/^\d+(?:\.\d+){0,3}$/.test(extensionVersion))
  throw new Error("Extension version must use the browser's numeric version format");

const tauriPath = path.join("apps", "desktop", "src-tauri", "tauri.conf.json");
const tauri = await readJson(tauriPath);
if (typeof tauri.version !== "string") throw new Error(`${tauriPath} is missing a version`);
versions.set(tauriPath, tauri.version);

const cargoPath = path.join("apps", "desktop", "src-tauri", "Cargo.toml");
const cargo = await readFile(path.join(root, cargoPath), "utf8");
let inPackageSection = false;
let cargoVersion: string | undefined;
for (const line of cargo.split(/\r?\n/)) {
  if (/^\s*\[.*\]\s*$/.test(line)) {
    inPackageSection = /^\s*\[package\]\s*$/.test(line);
  } else if (inPackageSection) {
    cargoVersion = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/)?.[1];
    if (cargoVersion) break;
  }
}
if (!cargoVersion) throw new Error(`${cargoPath} is missing [package].version`);
versions.set(cargoPath, cargoVersion);

const mismatches = [...versions].filter(([, version]) => version !== rootManifest.version);
if (mismatches.length > 0) {
  throw new Error(
    `Expected ${rootManifest.version} in every versioned workspace and Desktop manifest:\n${mismatches
      .map(([file, version]) => `- ${file}: ${version}`)
      .join("\n")}`,
  );
}

const binaryVersion = `${rootManifest.version.split("-")[0]}.0`;
const sidecarScript = "scripts/build-desktop-sidecar.ts";
const sidecarSource = await readFile(path.join(root, sidecarScript), "utf8");
const sidecarVersions = [...sidecarSource.matchAll(/--windows-version=([\d.]+)/g)].map(
  (match) => match[1],
);
if (sidecarVersions.length === 0 || sidecarVersions.some((version) => version !== binaryVersion))
  throw new Error(`${sidecarScript} must set Windows PE version ${binaryVersion}`);

console.log(
  `Release metadata matches ${rootManifest.version} (${versions.size} files); Extension ${extensionVersion}; Windows PE ${binaryVersion}`,
);
