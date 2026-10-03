import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import {
  type FileResult,
  KairomesError,
  LIMITS,
  type SearchResult,
  type Snapshot,
} from "@kairomes/protocol";
import { isPrivateName, resolveChecked, validateRelativePath } from "./paths.ts";
import type { WorkspaceRegistry } from "./registry.ts";

export function redactKnownSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[PRIVATE KEY REDACTED]",
    )
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, "[OPENAI KEY REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[GITHUB TOKEN REDACTED]",
    );
}

export class WorkspaceFiles {
  constructor(private readonly registry: WorkspaceRegistry) {}

  async snapshot(id: string, relative = "", limit = 100): Promise<Snapshot> {
    const row = this.registry.get(id);
    const target = await resolveChecked(row, relative);
    const directory = await opendir(target);
    const entries: Snapshot["entries"] = [];
    let visited = 0;
    let truncated = false;
    for await (const item of directory) {
      if (++visited > LIMITS.scanEntries) {
        truncated = true;
        break;
      }
      if (isPrivateName(item.name) || item.isSymbolicLink()) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      const itemPath = relative ? `${relative}/${item.name}` : item.name;
      try {
        validateRelativePath(itemPath);
      } catch {
        continue;
      }
      if (entries.length === limit) {
        truncated = true;
        break;
      }
      entries.push({
        name: item.name,
        path: itemPath,
        kind: item.isDirectory() ? "directory" : "file",
      });
    }
    await resolveChecked(row, relative);
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
    );
    return {
      kind: "snapshot",
      workspace: { id: row.id, name: row.name, capabilities: ["read"] },
      path: relative,
      entries,
      truncated,
    };
  }

  private async readText(
    id: string,
    relative: string,
    byteLimit = LIMITS.fileBytes as number,
  ): Promise<{ text: string; bytes: number; version: string; redacted: boolean }> {
    validateRelativePath(relative);
    const root = this.registry.get(id);
    const target = await resolveChecked(root, relative);
    if (!(await lstat(target)).isFile())
      throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
      if (before.nlink > 1n)
        throw new KairomesError("LINK_BLOCKED", "此版本不讀取多重硬連結檔案。");
      if (before.size > BigInt(Math.min(LIMITS.fileBytes, byteLimit)))
        throw new KairomesError(
          "FILE_TOO_LARGE",
          byteLimit < LIMITS.fileBytes ? "檔案超過剩餘核對大小上限。" : "檔案超過 1 MiB 讀取上限。",
        );
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
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
      ) {
        throw new KairomesError("FILE_CHANGED", "檔案在讀取途中改變，請重試。");
      }
      const data = buffer.subarray(0, bytes);
      if (data.includes(0)) throw new KairomesError("BINARY_FILE", "此版本僅支援 UTF-8 文字檔。");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new KairomesError("BINARY_FILE", "此版本僅支援 UTF-8 文字檔。");
      }
      const safe = redactKnownSecrets(text);
      return {
        text: safe,
        bytes,
        version: createHash("sha256").update(data).digest("hex"),
        redacted: safe !== text,
      };
    } finally {
      await handle.close();
    }
  }

  async read(id: string, relative: string, startLine = 1, maxLines = 150): Promise<FileResult> {
    const file = await this.readText(id, relative);
    const lines = file.text.split(/\r?\n/);
    const selected: string[] = [];
    let bytes = 0;
    let index = startLine - 1;
    while (index < lines.length && selected.length < maxLines) {
      const line = lines[index] ?? "";
      const length = Buffer.byteLength(line) + 1;
      if (bytes + length > LIMITS.responseBytes) {
        if (selected.length === 0)
          throw new KairomesError("LINE_TOO_LONG", "單行內容超過輸出上限，請改用搜尋。");
        break;
      }
      selected.push(line);
      bytes += length;
      index++;
    }
    const truncated = index < lines.length;
    return {
      kind: "file",
      workspace_id: id,
      path: relative,
      content: selected.join("\n"),
      version: file.version,
      start_line: startLine,
      total_lines: lines.length,
      next_line: truncated ? index + 1 : null,
      truncated,
      redacted: file.redacted,
    };
  }

  /** Local version checks use the exact same bounded, link-safe UTF-8 read as file_read. */
  async version(
    id: string,
    relative: string,
    byteLimit = LIMITS.fileBytes as number,
  ): Promise<{ bytes: number; version: string }> {
    if (!Number.isInteger(byteLimit) || byteLimit < 0)
      throw new KairomesError("FILE_LIMIT", "檔案核對大小上限不正確。");
    const file = await this.readText(id, relative, byteLimit);
    return { bytes: file.bytes, version: file.version };
  }

  async search(id: string, query: string, limit = 30): Promise<SearchResult> {
    const root = this.registry.get(id);
    const result: SearchResult = {
      kind: "search",
      workspace_id: id,
      query,
      matches: [],
      truncated: false,
      scanned_files: 0,
      skipped_files: 0,
    };
    const queue = [""];
    const deadline = performance.now() + LIMITS.scanMilliseconds;
    let visited = 0;
    let bytes = 0;
    const needle = query.toLocaleLowerCase();
    outer: while (queue.length > 0) {
      const relative = queue.shift() ?? "";
      let directory: Awaited<ReturnType<typeof opendir>>;
      try {
        directory = await opendir(await resolveChecked(root, relative));
      } catch {
        result.skipped_files++;
        continue;
      }
      for await (const item of directory) {
        if (
          ++visited > LIMITS.scanEntries ||
          performance.now() > deadline ||
          bytes >= LIMITS.scanBytes
        ) {
          result.truncated = true;
          break outer;
        }
        if (isPrivateName(item.name) || item.isSymbolicLink()) {
          result.skipped_files++;
          continue;
        }
        const itemPath = relative ? `${relative}/${item.name}` : item.name;
        try {
          validateRelativePath(itemPath);
        } catch {
          result.skipped_files++;
          continue;
        }
        if (item.isDirectory()) {
          if (itemPath.split("/").length < 12) queue.push(itemPath);
          else result.truncated = true;
          continue;
        }
        if (!item.isFile()) continue;
        try {
          const file = await this.readText(id, itemPath);
          bytes += file.bytes;
          result.scanned_files++;
          const lines = file.text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            const matchIndex = line.toLocaleLowerCase().indexOf(needle);
            if (matchIndex < 0) continue;
            const start = Math.max(0, matchIndex - 100);
            result.matches.push({
              path: itemPath,
              line: i + 1,
              text: `${start > 0 ? "…" : ""}${line.slice(start, start + 400)}${line.length > start + 400 ? "…" : ""}`,
            });
            if (result.matches.length >= limit) {
              result.truncated = true;
              break outer;
            }
          }
        } catch {
          result.skipped_files++;
        }
      }
    }
    this.registry.get(id);
    return result;
  }
}
