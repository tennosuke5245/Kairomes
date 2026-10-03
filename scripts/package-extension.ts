import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const extension = path.join(root, "apps", "extension");
const dist = path.join(extension, "dist");
const releaseDir = path.join(root, "dist", "releases");
const expectedFiles = [
  "assets/kairomes-k-128.png",
  "background.js",
  "manifest.json",
  "mcp-panel.css",
  "sidepanel.css",
  "sidepanel.html",
  "sidepanel.js",
].sort();

type VersionedManifest = { version?: unknown };
type BrowserManifest = VersionedManifest & {
  background?: { service_worker?: unknown };
  side_panel?: { default_path?: unknown };
};

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Unexpected extension build entry: ${relative}`);
    }
  }
  return files.sort();
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files: Array<{ name: string; contents: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    if (name.length > 0xffff || file.contents.length > 0xffffffff) {
      throw new Error(`Extension file is too large for a ZIP archive: ${file.name}`);
    }
    const checksum = crc32(file.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filenames.
    local.writeUInt16LE(0, 8); // Stored without compression.
    local.writeUInt16LE(0, 10); // 00:00:00.
    local.writeUInt16LE(0x0021, 12); // 1980-01-01.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.contents.length, 18);
    local.writeUInt32LE(file.contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, file.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.contents.length, 20);
    central.writeUInt32LE(file.contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + file.contents.length;
  }

  if (files.length > 0xffff) throw new Error("Too many files in the extension archive");
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const rootManifest = await readJson<VersionedManifest>(path.join(root, "package.json"));
const packageManifest = await readJson<VersionedManifest>(path.join(extension, "package.json"));
const sourceManifest = await readJson<BrowserManifest>(path.join(extension, "manifest.json"));
const version = rootManifest.version;
if (
  typeof version !== "string" ||
  !/^\d+(?:\.\d+){0,3}$/.test(version) ||
  packageManifest.version !== version ||
  sourceManifest.version !== version
) {
  throw new Error("Root, extension package, and browser manifest versions must match");
}
if (
  sourceManifest.background?.service_worker !== "background.js" ||
  sourceManifest.side_panel?.default_path !== "sidepanel.html"
) {
  throw new Error("Extension manifest references an unexpected build file");
}

// The build clears dist first. Only the reviewed output files may enter the release archive.
await import("./build-extension.ts");
const builtFiles = await listFiles(dist);
if (JSON.stringify(builtFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(
    `Unexpected extension build files. Expected ${expectedFiles.join(", ")}; found ${builtFiles.join(", ")}`,
  );
}
const sourceManifestBytes = await readFile(path.join(extension, "manifest.json"));
const builtManifestBytes = await readFile(path.join(dist, "manifest.json"));
if (!sourceManifestBytes.equals(builtManifestBytes)) {
  throw new Error("Built extension manifest differs from the checked source manifest");
}
const html = await readFile(path.join(dist, "sidepanel.html"), "utf8");
for (const reference of [
  'href="sidepanel.css"',
  'href="mcp-panel.css"',
  'src="sidepanel.js"',
  'src="assets/kairomes-k-128.png"',
]) {
  if (!html.includes(reference)) throw new Error(`Side panel is missing ${reference}`);
}

const archiveFiles = await Promise.all(
  expectedFiles.map(async (name) => {
    const filename = path.join(dist, ...name.split("/"));
    if (!(await lstat(filename)).isFile()) throw new Error(`Not a regular extension file: ${name}`);
    return { name, contents: await readFile(filename) };
  }),
);
const archive = createZip(archiveFiles);
await mkdir(releaseDir, { recursive: true });
const output = path.join(releaseDir, `Kairomes-extension-v${version}.zip`);
await writeFile(output, archive);
console.log(`Extension release: ${output}`);
console.log(`SHA-256: ${createHash("sha256").update(archive).digest("hex")}`);
