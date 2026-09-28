import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { KairomesError } from "@kairomes/protocol";

const deniedDirectories = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".config",
  ".kairomes",
  "node_modules",
  ".next",
  "dist",
  "coverage",
]);
const deniedFiles = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

export function isPrivateName(name: string): boolean {
  const n = name.toLowerCase();
  return (
    deniedDirectories.has(n) ||
    deniedFiles.has(n) ||
    n.startsWith(".kairomes-") ||
    n.startsWith(".env") ||
    /\.(pem|key|p12|pfx|sqlite|sqlite3|db)(-wal|-shm)?$/i.test(n)
  );
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (
      code < 32 ||
      code === 127 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

export function validateRelativePath(value: string, allowRoot = false): string[] {
  if (allowRoot && value === "") return [];
  if (!value || value.startsWith("/") || /[\\:]/u.test(value) || hasControlCharacters(value)) {
    throw new KairomesError("INVALID_PATH", "請使用工作區內的相對路徑與 / 分隔符號。");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new KairomesError("INVALID_PATH", "路徑包含不允許的片段。");
  }
  if (parts.some(isPrivateName)) {
    throw new KairomesError("PRIVATE_PATH", "此路徑依本機政策不提供給模型。");
  }
  return parts;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

export type RootIdentity = { root: string; dev: string; ino: string };

export async function identifyRoot(input: string): Promise<RootIdentity> {
  const root = await realpath(path.resolve(input));
  if (path.parse(root).root === root) {
    throw new KairomesError("BROAD_ROOT", "請掛載專案資料夾，不能掛載磁碟或檔案系統根目錄。");
  }
  const info = await stat(root, { bigint: true });
  if (!info.isDirectory()) throw new KairomesError("NOT_DIRECTORY", "工作區必須是資料夾。");
  return { root, dev: String(info.dev), ino: String(info.ino) };
}

export async function resolveChecked(root: RootIdentity, relative: string): Promise<string> {
  const parts = validateRelativePath(relative, true);
  const rootInfo = await lstat(root.root, { bigint: true });
  if (
    rootInfo.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    String(rootInfo.dev) !== root.dev ||
    String(rootInfo.ino) !== root.ino
  ) {
    throw new KairomesError("WORKSPACE_CHANGED", "工作區已被替換，請在本機重新掛載。");
  }
  if ((await realpath(root.root)) !== root.root) {
    throw new KairomesError("WORKSPACE_CHANGED", "工作區的實際路徑已改變。");
  }
  let current = root.root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new KairomesError("LINK_BLOCKED", "此版本不讀取符號連結或 junction。");
    }
    const canonical = await realpath(current);
    if (!isWithin(root.root, canonical)) {
      throw new KairomesError("OUTSIDE_WORKSPACE", "路徑超出掛載工作區。");
    }
  }
  return current;
}
