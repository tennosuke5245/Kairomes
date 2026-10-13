import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { type FileChangeOperation, KairomesError, LIMITS } from "@kairomes/protocol";
import { redactKnownSecrets } from "./files.ts";
import { isWithin, type RootIdentity, resolveChecked, validateRelativePath } from "./paths.ts";
import type { WorkspaceRegistry } from "./registry.ts";

type SourceFile = {
  target: string;
  data: Buffer;
  text: string;
  version: string;
  mode: number;
  bom: boolean;
  newline: "lf" | "crlf";
};

/** New folder levels one path may add, and new folders one batch may add. */
export const MAX_NEW_FOLDER_LEVELS = 4;
export const MAX_NEW_FOLDERS = 16;

type PlannedFolder = {
  /** Workspace-relative path without a trailing slash. */
  path: string;
  target: string;
};

type PreparedFileChange = {
  operation: FileChangeOperation["operation"];
  path: string;
  /** For mkdir, the folder itself; it has no content and is never a delete. */
  target: string;
  before: Buffer | null;
  after: Buffer | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  mode: number;
  /** Empty for mkdir: every new folder has its own entry in the batch diff. */
  diff: string;
  /** Relative paths of the planned folders this operation introduced, shallow to deep. */
  folders: string[];
};

export type PreparedWorkspaceChange = {
  workspaceId: string;
  /** Created by apply() in this order (shallow to deep) before any file is written. */
  folders: PlannedFolder[];
  files: PreparedFileChange[];
  diff: string;
  diffTruncated: boolean;
};

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const pathKey = (value: string) =>
  process.platform === "win32" ? value.toLocaleLowerCase() : value;
const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

function normalizeInput(text: string) {
  if (text.includes("\0")) throw new KairomesError("BINARY_FILE", "檔案內容不能包含 NUL。");
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r"))
    throw new KairomesError("LINE_ENDINGS", "此版本不支援單獨 CR 換行。");
  return normalized;
}

async function readSource(
  registry: WorkspaceRegistry,
  workspaceId: string,
  relative: string,
): Promise<SourceFile> {
  validateRelativePath(relative);
  const root = registry.get(workspaceId);
  const target = await resolveChecked(root, relative);
  if (!(await lstat(target)).isFile()) throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
    if (before.nlink > 1n) throw new KairomesError("LINK_BLOCKED", "此版本不修改多重硬連結檔案。");
    if (before.size > BigInt(LIMITS.fileBytes))
      throw new KairomesError("FILE_TOO_LARGE", "檔案超過 1 MiB 修改上限。");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (part.bytesRead === 0) break;
      bytes += part.bytesRead;
    }
    await resolveChecked(root, relative);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (
      bytes !== Number(before.size) ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.nlink > 1n ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      after.size !== before.size
    )
      throw new KairomesError("FILE_CHANGED", "檔案在讀取途中改變，請重試。");
    const data = buffer.subarray(0, bytes);
    if (data.includes(0)) throw new KairomesError("BINARY_FILE", "此版本僅支援 UTF-8 文字檔。");
    const bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bom ? data.subarray(3) : data);
    } catch {
      throw new KairomesError("BINARY_FILE", "此版本僅支援 UTF-8 文字檔。");
    }
    const withoutCrlf = decoded.replace(/\r\n/g, "");
    if (withoutCrlf.includes("\r"))
      throw new KairomesError("LINE_ENDINGS", "此檔案使用不支援的 CR 換行。");
    const hasCrlf = decoded.includes("\r\n");
    const hasLf = withoutCrlf.includes("\n");
    if (hasCrlf && hasLf)
      throw new KairomesError("LINE_ENDINGS", "此檔案混用 LF 與 CRLF，請先統一換行格式。");
    const text = hasCrlf ? decoded.replace(/\r\n/g, "\n") : decoded;
    if (redactKnownSecrets(text) !== text)
      throw new KairomesError(
        "SENSITIVE_FILE",
        "檔案包含已知密鑰格式；Kairomes 不會把原文交給模型或透過結構化工具覆寫。",
      );
    return {
      target,
      data: Buffer.from(data),
      text,
      version: digest(data),
      mode: Number(before.mode & 0o777n),
      bom,
      newline: hasCrlf ? "crlf" : "lf",
    };
  } finally {
    await handle.close();
  }
}

async function newTarget(registry: WorkspaceRegistry, workspaceId: string, relative: string) {
  const parts = validateRelativePath(relative);
  const root = registry.get(workspaceId);
  const parentRelative = parts.slice(0, -1).join("/");
  const parent = await resolveChecked(root, parentRelative);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory())
    throw new KairomesError("NOT_DIRECTORY", "新檔案的上層路徑必須是既有資料夾。");
  const target = path.join(parent, parts.at(-1) ?? "");
  if (!isWithin(root.root, target))
    throw new KairomesError("OUTSIDE_WORKSPACE", "路徑超出掛載工作區。");
  try {
    await lstat(target);
    throw new KairomesError("FILE_EXISTS", "檔案已存在；覆寫時必須提供 expected_version。");
  } catch (error) {
    if (error instanceof KairomesError) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if ((await realpath(parent)) !== parent)
    throw new KairomesError("WORKSPACE_CHANGED", "上層資料夾的實際路徑已改變。");
  return target;
}

/**
 * Resolves the folder `parts` (a new file's parent, or a mkdir target). Existing ancestors go
 * through resolveChecked, so links and junctions stay blocked; missing ones are planned shallow
 * to deep and only apply() creates them. A folder another operation of the batch already
 * planned is reused, not planned twice.
 */
async function planFolders(
  root: RootIdentity,
  parts: string[],
  planned: Map<string, PlannedFolder>,
  claimed: Set<string>,
) {
  let target = root.root;
  let existing = true;
  let levels = 0;
  const folders: PlannedFolder[] = [];
  for (const [index, part] of parts.entries()) {
    const relative = parts.slice(0, index + 1).join("/");
    validateRelativePath(relative);
    const key = pathKey(relative);
    const known = planned.get(key);
    if (existing && !known) {
      try {
        target = await resolveChecked(root, relative);
        if (!(await lstat(target)).isDirectory())
          throw new KairomesError(
            "NOT_DIRECTORY",
            "路徑上已有同名的非資料夾項目，無法建立資料夾。",
          );
        continue;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    existing = false;
    levels++;
    if (known) {
      target = known.target;
      continue;
    }
    // An earlier operation of the batch already uses this path for a file.
    if (claimed.has(key))
      throw new KairomesError("CHANGE_DUPLICATE", "同一批變更不能把同一路徑同時當作檔案與資料夾。");
    target = path.join(target, part);
    if (!isWithin(root.root, target))
      throw new KairomesError("OUTSIDE_WORKSPACE", "路徑超出掛載工作區。");
    const folder = { path: relative, target };
    planned.set(key, folder);
    folders.push(folder);
  }
  if (levels > MAX_NEW_FOLDER_LEVELS)
    throw new KairomesError(
      "FOLDER_LIMIT",
      `一次最多建立 ${MAX_NEW_FOLDER_LEVELS} 層新資料夾；請先建立較淺的資料夾。`,
    );
  if (planned.size > MAX_NEW_FOLDERS)
    throw new KairomesError(
      "FOLDER_LIMIT",
      `同一批最多建立 ${MAX_NEW_FOLDERS} 個新資料夾；請拆成較小批次。`,
    );
  return { target, folders, existing };
}

type CreatedFolder = { target: string; dev: bigint; ino: bigint };

/**
 * Creates one planned folder without following links. A real folder someone else created
 * inside the workspace meanwhile is used but not owned; anything else is a conflict.
 */
async function createFolder(root: RootIdentity, folder: PlannedFolder, created: CreatedFolder[]) {
  const parent = await resolveChecked(root, folder.path.split("/").slice(0, -1).join("/"));
  if (
    !(await lstat(parent)).isDirectory() ||
    (await realpath(parent)) !== parent ||
    path.join(parent, path.basename(folder.target)) !== folder.target
  )
    throw new KairomesError("WORKSPACE_CHANGED", "新資料夾的上層路徑已改變，沒有套用變更。");
  let owned = true;
  try {
    await mkdir(folder.target, { mode: 0o755 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    owned = false;
  }
  const info = await lstat(folder.target, { bigint: true });
  if (info.isSymbolicLink())
    throw new KairomesError(
      "LINK_BLOCKED",
      `資料夾 ${folder.path} 已被換成符號連結或 junction，沒有套用變更。`,
    );
  if (!info.isDirectory())
    throw new KairomesError("NOT_DIRECTORY", `${folder.path} 已被其他項目佔用，沒有套用變更。`);
  if (owned) created.push({ target: folder.target, dev: info.dev, ino: info.ino });
  const canonical = await realpath(folder.target);
  if (canonical !== folder.target || !isWithin(root.root, canonical))
    throw new KairomesError(
      "LINK_BLOCKED",
      `資料夾 ${folder.path} 的實際路徑已改變，沒有套用變更。`,
    );
}

/** Rollback: removes only the empty folders this apply created, deepest first. */
async function removeFolders(created: CreatedFolder[]) {
  for (const folder of created.reverse()) {
    try {
      const info = await lstat(folder.target, { bigint: true });
      // A folder that now holds other files, or was replaced, is left alone.
      if (info.isDirectory() && info.dev === folder.dev && info.ino === folder.ino)
        await rmdir(folder.target);
    } catch {}
  }
}

const folderDiff = (folder: PlannedFolder) =>
  ["--- /dev/null", `+++ b/${folder.path}/`, "@@ create folder @@"].join("\n");

function encode(text: string, source?: SourceFile) {
  const normalized = normalizeInput(text);
  const serialized = source?.newline === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;
  const content = Buffer.from(serialized, "utf8");
  return source?.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
}

function prefixed(prefix: "+" | "-" | " ", value: string) {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

function focusedDiff(pathname: string, before: string, after: string) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head])
    head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  )
    tail++;
  const contextStart = Math.max(0, head - 2);
  // Up to two unchanged lines on each side, taken next to the change (not the file's end).
  const trailingStart = newLines.length - tail;
  return [
    `--- a/${pathname}`,
    `+++ b/${pathname}`,
    `@@ ${head + 1} @@`,
    ...oldLines.slice(contextStart, head).map((line) => ` ${line}`),
    ...oldLines.slice(head, oldLines.length - tail).map((line) => `-${line}`),
    ...newLines.slice(head, trailingStart).map((line) => `+${line}`),
    ...newLines.slice(trailingStart, trailingStart + Math.min(2, tail)).map((line) => ` ${line}`),
  ].join("\n");
}

function operationDiff(
  operation: FileChangeOperation,
  before: string | null,
  after: string | null,
) {
  if (operation.operation === "edit")
    return [
      `--- a/${operation.path}`,
      `+++ b/${operation.path}`,
      ...operation.replacements.flatMap((replacement, index) => [
        `@@ exact replacement ${index + 1}${replacement.replace_all ? " · all matches" : ""} @@`,
        ...prefixed("-", normalizeInput(replacement.old_text)),
        ...prefixed("+", normalizeInput(replacement.new_text)),
      ]),
    ].join("\n");
  if (operation.operation === "delete")
    return [
      `--- a/${operation.path}`,
      "+++ /dev/null",
      "@@ delete file @@",
      ...prefixed("-", before ?? ""),
    ].join("\n");
  if (before === null)
    return [
      "--- /dev/null",
      `+++ b/${operation.path}`,
      "@@ create file @@",
      ...prefixed("+", after ?? ""),
    ].join("\n");
  return focusedDiff(operation.path, before, after ?? "");
}

async function writeTemp(file: PreparedFileChange) {
  if (!file.after) throw new Error("missing staged content");
  const temporary = path.join(
    path.dirname(file.target),
    `.kairomes-${path.basename(file.target)}-${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", file.mode || 0o644);
  try {
    await handle.writeFile(file.after);
    await handle.sync();
    await handle.chmod(file.mode || 0o644);
  } finally {
    await handle.close();
  }
  return temporary;
}

export class WorkspaceChanges {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async prepare(
    workspaceId: string,
    operations: FileChangeOperation[],
  ): Promise<PreparedWorkspaceChange> {
    const root = this.registry.get(workspaceId);
    const seen = new Set<string>();
    // Insertion order is creation order: a folder's parent is always planned before it.
    const planned = new Map<string, PlannedFolder>();
    const files: PreparedFileChange[] = [];
    for (const operation of operations) {
      const parts = validateRelativePath(operation.path);
      const key = pathKey(operation.path);
      if (seen.has(key))
        throw new KairomesError("CHANGE_DUPLICATE", "同一批變更不能重複指定同一個檔案。");
      if (planned.has(key))
        throw new KairomesError("CHANGE_DUPLICATE", "同一批變更已會在此路徑建立資料夾。");
      if (operation.operation === "mkdir") {
        const plan = await planFolders(root, parts, planned, seen);
        if (plan.existing) throw new KairomesError("NO_CHANGES", "資料夾已存在，不需要建立。");
        seen.add(key);
        files.push({
          operation: "mkdir",
          path: operation.path,
          target: plan.target,
          before: null,
          after: null,
          beforeVersion: null,
          afterVersion: null,
          mode: 0o755,
          diff: "",
          folders: plan.folders.map((folder) => folder.path),
        });
        continue;
      }
      let source: SourceFile | undefined;
      if (operation.operation !== "write" || operation.expected_version)
        source = await readSource(this.registry, workspaceId, operation.path);
      if (
        source &&
        "expected_version" in operation &&
        operation.expected_version !== source.version
      )
        throw new KairomesError("VERSION_CONFLICT", "檔案版本已改變，請重新讀取後再提出變更。");
      let next: string | null;
      let created: { target: string; folders: string[] } | undefined;
      if (operation.operation === "edit") {
        next = source?.text ?? "";
        for (const replacement of operation.replacements) {
          const oldText = normalizeInput(replacement.old_text);
          const newText = normalizeInput(replacement.new_text);
          if (oldText === newText) throw new KairomesError("NO_CHANGES", "舊內容與新內容相同。");
          const count = next.split(oldText).length - 1;
          if (count === 0)
            throw new KairomesError("EDIT_NOT_FOUND", "找不到要替換的精確舊內容，請重新讀取檔案。");
          if (!replacement.replace_all && count !== 1)
            throw new KairomesError(
              "EDIT_AMBIGUOUS",
              "舊內容不只出現一次；請提供更多上下文或明確使用 replace_all。",
            );
          next = replacement.replace_all
            ? next.split(oldText).join(newText)
            : next.replace(oldText, newText);
        }
      } else if (operation.operation === "write") {
        next = normalizeInput(operation.content);
        if (!operation.expected_version) {
          const plan = await planFolders(root, parts.slice(0, -1), planned, seen);
          created = {
            target: plan.existing
              ? await newTarget(this.registry, workspaceId, operation.path)
              : path.join(plan.target, parts.at(-1) ?? ""),
            folders: plan.folders.map((folder) => folder.path),
          };
        }
      } else next = null;
      if (next !== null && redactKnownSecrets(next) !== next)
        throw new KairomesError(
          "SENSITIVE_CONTENT",
          "變更內容包含已知密鑰格式；請勿透過模型寫入憑證。",
        );
      const after = next === null ? null : encode(next, source);
      if (after && after.byteLength > LIMITS.fileBytes)
        throw new KairomesError("FILE_TOO_LARGE", "變更後的檔案超過 1 MiB 上限。");
      if (source && after?.equals(source.data))
        throw new KairomesError("NO_CHANGES", "變更後的檔案內容與目前版本相同。");
      const target = source?.target ?? created?.target;
      if (!target) throw new Error("missing change target");
      seen.add(key);
      files.push({
        operation: operation.operation,
        path: operation.path,
        target,
        before: source?.data ?? null,
        after,
        beforeVersion: source?.version ?? null,
        afterVersion: after ? digest(after) : null,
        mode: source?.mode ?? 0o644,
        diff: operationDiff(operation, source?.text ?? null, next),
        folders: created?.folders ?? [],
      });
    }
    const folders = [...planned.values()];
    // Each new folder is its own entry, before the file diffs and in creation order.
    const full = [
      ...folders.map(folderDiff),
      ...files.filter((file) => file.operation !== "mkdir").map((file) => file.diff),
    ].join("\n\n");
    if (Buffer.byteLength(full) > 192 * 1024)
      throw new KairomesError(
        "CHANGE_REVIEW_TOO_LARGE",
        "這批差異超過本機完整審查上限；請拆成較小批次。",
      );
    return {
      workspaceId,
      folders,
      files,
      diff: full,
      diffTruncated: false,
    };
  }

  async apply(change: PreparedWorkspaceChange) {
    const root = this.registry.get(change.workspaceId);
    const plannedTargets = new Set(change.folders.map((folder) => folder.target));
    for (const file of change.files) {
      // A mkdir target, and a new file inside a planned folder, are checked when that folder
      // is created below, still before any file is written.
      if (file.operation === "mkdir") continue;
      if (file.beforeVersion) {
        const current = await readSource(this.registry, change.workspaceId, file.path);
        if (current.target !== file.target || current.version !== file.beforeVersion)
          throw new KairomesError(
            "VERSION_CONFLICT",
            `檔案 ${file.path} 已在核准前改變，沒有套用任何變更。`,
          );
      } else if (!plannedTargets.has(path.dirname(file.target))) {
        await newTarget(this.registry, change.workspaceId, file.path);
      }
    }
    const applied: Array<{ file: PreparedFileChange; trash?: string }> = [];
    const staged: string[] = [];
    const created: CreatedFolder[] = [];
    try {
      for (const folder of change.folders) await createFolder(root, folder, created);
      for (const file of change.files) {
        if (file.after) staged.push(await writeTemp(file));
      }
      for (const file of change.files) {
        if (file.operation === "mkdir") continue;
        // Staging can take time. Re-check the exact target immediately before
        // each mutation; if a later file conflicts, the already applied files
        // below are rolled back from their in-memory originals.
        if (file.beforeVersion) {
          const current = await readSource(this.registry, change.workspaceId, file.path);
          if (current.target !== file.target || current.version !== file.beforeVersion)
            throw new KairomesError(
              "VERSION_CONFLICT",
              `檔案 ${file.path} 已在套用前改變，正在復原本批已處理項目。`,
            );
        } else await newTarget(this.registry, change.workspaceId, file.path);
        if (!file.after) {
          const trash = path.join(
            path.dirname(file.target),
            `.kairomes-delete-${path.basename(file.target)}-${crypto.randomUUID()}.tmp`,
          );
          await rename(file.target, trash);
          applied.push({ file, trash });
          continue;
        }
        const temporary = staged.shift();
        if (!temporary) throw new Error("missing staged file");
        if (file.before) await rename(temporary, file.target);
        else {
          try {
            await link(temporary, file.target);
          } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
              throw new KairomesError(
                "VERSION_CONFLICT",
                `檔案 ${file.path} 已在核准前建立，沒有覆寫。`,
              );
            throw error;
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        applied.push({ file });
      }
      for (const file of change.files) {
        if (!file.after) continue;
        const current = await readSource(this.registry, change.workspaceId, file.path);
        if (current.version !== file.afterVersion)
          throw new KairomesError("WRITE_VERIFY", "寫入後驗證失敗；請重新檢查工作區。");
      }
      // Backups are no longer needed only after every resulting file verifies.
      // Cleanup failure leaves a hidden temporary backup but must not turn a
      // successfully committed batch into a risky rollback attempt.
      for (const item of applied) if (item.trash) await unlink(item.trash).catch(() => {});
    } catch (error) {
      let rollbackFailed = false;
      for (const item of applied.reverse()) {
        try {
          if (item.trash) await rename(item.trash, item.file.target);
          else if (!item.file.before) await unlink(item.file.target);
          else {
            const restore: PreparedFileChange = { ...item.file, after: item.file.before };
            await rename(await writeTemp(restore), item.file.target);
          }
        } catch {
          rollbackFailed = true;
        }
      }
      for (const temporary of staged) await unlink(temporary).catch(() => {});
      await removeFolders(created);
      if (rollbackFailed)
        throw new KairomesError(
          "ROLLBACK_FAILED",
          "套用中斷且部分檔案未能自動復原；請立即檢查變更清單。",
        );
      throw error;
    }
  }
}
