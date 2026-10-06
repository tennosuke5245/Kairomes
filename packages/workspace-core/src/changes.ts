import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { type FileChangeOperation, KairomesError, LIMITS } from "@kairomes/protocol";
import { redactKnownSecrets } from "./files.ts";
import { isWithin, resolveChecked, validateRelativePath } from "./paths.ts";
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

type PreparedFileChange = {
  operation: FileChangeOperation["operation"];
  path: string;
  target: string;
  before: Buffer | null;
  after: Buffer | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  mode: number;
  diff: string;
};

export type PreparedWorkspaceChange = {
  workspaceId: string;
  files: PreparedFileChange[];
  diff: string;
  diffTruncated: boolean;
};

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

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
    this.registry.get(workspaceId);
    const seen = new Set<string>();
    const files: PreparedFileChange[] = [];
    for (const operation of operations) {
      validateRelativePath(operation.path);
      const key =
        process.platform === "win32" ? operation.path.toLocaleLowerCase() : operation.path;
      if (seen.has(key))
        throw new KairomesError("CHANGE_DUPLICATE", "同一批變更不能重複指定同一個檔案。");
      seen.add(key);
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
        if (!operation.expected_version)
          await newTarget(this.registry, workspaceId, operation.path);
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
      const target =
        source?.target ?? (await newTarget(this.registry, workspaceId, operation.path));
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
      });
    }
    const full = files.map((file) => file.diff).join("\n\n");
    if (Buffer.byteLength(full) > 192 * 1024)
      throw new KairomesError(
        "CHANGE_REVIEW_TOO_LARGE",
        "這批差異超過本機完整審查上限；請拆成較小批次。",
      );
    return {
      workspaceId,
      files,
      diff: full,
      diffTruncated: false,
    };
  }

  async apply(change: PreparedWorkspaceChange) {
    this.registry.get(change.workspaceId);
    for (const file of change.files) {
      if (file.beforeVersion) {
        const current = await readSource(this.registry, change.workspaceId, file.path);
        if (current.target !== file.target || current.version !== file.beforeVersion)
          throw new KairomesError(
            "VERSION_CONFLICT",
            `檔案 ${file.path} 已在核准前改變，沒有套用任何變更。`,
          );
      } else {
        await newTarget(this.registry, change.workspaceId, file.path);
      }
    }
    const applied: Array<{ file: PreparedFileChange; trash?: string }> = [];
    const staged: string[] = [];
    try {
      for (const file of change.files) {
        if (file.after) staged.push(await writeTemp(file));
      }
      for (const file of change.files) {
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
      if (rollbackFailed)
        throw new KairomesError(
          "ROLLBACK_FAILED",
          "套用中斷且部分檔案未能自動復原；請立即檢查變更清單。",
        );
      throw error;
    }
  }
}
