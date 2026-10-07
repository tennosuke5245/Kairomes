import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import {
  type FileFindResult,
  type FileReadManyEntry,
  type FileReadManyResult,
  type FileResult,
  isGlobQuery,
  isSafeGlobPattern,
  KairomesError,
  LIMITS,
  publicError,
  type SearchResult,
  type Snapshot,
} from "@kairomes/protocol";
import { isPrivateName, type RootIdentity, resolveChecked, validateRelativePath } from "./paths.ts";
import type { WorkspaceRegistry } from "./registry.ts";

const privateKeyBegin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const privateKeyEnd = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Replaces each BEGIN … END PRIVATE KEY block in one linear pass. A lazy regular expression
 * rescans the rest of the text for every BEGIN without an END, which is quadratic; once one
 * BEGIN has no END after it, no later BEGIN can have one either.
 */
function redactPrivateKeys(value: string) {
  let result = "";
  let copied = 0;
  privateKeyBegin.lastIndex = 0;
  for (let begin = privateKeyBegin.exec(value); begin; begin = privateKeyBegin.exec(value)) {
    privateKeyEnd.lastIndex = begin.index + begin[0].length;
    const end = privateKeyEnd.exec(value);
    if (!end) break;
    result += `${value.slice(copied, begin.index)}[PRIVATE KEY REDACTED]`;
    copied = end.index + end[0].length;
    privateKeyBegin.lastIndex = copied;
  }
  return copied === 0 ? value : result + value.slice(copied);
}

export function redactKnownSecrets(value: string): string {
  return redactPrivateKeys(value)
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, "[OPENAI KEY REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[GITHUB TOKEN REDACTED]",
    );
}

type TextFile = { text: string; bytes: number; version: string; redacted: boolean };

/** Bounds for one file_search or file_find walk. Tests may tighten them. */
export type FileScanBudget = {
  walkEntries: number;
  scanBytes: number;
  scanMilliseconds: number;
  now: () => number;
};

export type SearchOptions = {
  /** Relative directory scope; "" is the workspace root. */
  path?: string;
  caseSensitive?: boolean;
  /** Glob patterns; a pattern with / matches the relative path, otherwise the file name. */
  include?: readonly string[];
  contextLines?: number;
};

type CheckedDirectory = { path: string; dev: bigint; ino: bigint };
type WalkItem = {
  relative: string;
  name: string;
  type: "file" | "directory";
  directory: CheckedDirectory;
};
type WalkState = { visited: number; skipped: number; truncated: boolean; deadline: number };
type Settled<T> = { value: T } | { error: unknown };
type ByteMeter = { bytes: number; limit: number };

const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/** The first read is capped so binary files are usually rejected without reading them whole. */
const sniffBytes = 8192;
const excerptLength = 400;
const maxDepth = 12;
/** File reads started ahead of the in-order visitor within one directory. */
const prefetchWindow = 8;

function binaryFile() {
  return new KairomesError("BINARY_FILE", "此版本僅支援 UTF-8 文字檔。");
}
function changedFile() {
  return new KairomesError("FILE_CHANGED", "檔案在讀取途中改變，請重試。");
}
function isScanBudget(error: unknown) {
  return error instanceof KairomesError && error.code === "SCAN_BUDGET";
}

/**
 * Reads one regular, single-link file without following a final link. After reading,
 * `recheck` re-verifies the containing path and the opened inode must still be at `target`.
 */
async function readVerifiedText(
  target: string,
  byteLimit: number,
  recheck: () => Promise<void>,
  meter?: ByteMeter,
): Promise<TextFile> {
  const handle = await open(target, openFlags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
    if (before.nlink > 1n) throw new KairomesError("LINK_BLOCKED", "此版本不讀取多重硬連結檔案。");
    if (before.size > BigInt(Math.min(LIMITS.fileBytes, byteLimit)))
      throw new KairomesError(
        "FILE_TOO_LARGE",
        byteLimit < LIMITS.fileBytes ? "檔案超過剩餘核對大小上限。" : "檔案超過 1 MiB 讀取上限。",
      );
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const length = bytes === 0 ? Math.min(buffer.length, sniffBytes) : buffer.length - bytes;
      if (meter) {
        // Reserve before reading so concurrent reads can never exceed the scan budget.
        if (meter.bytes + length > meter.limit)
          throw new KairomesError("SCAN_BUDGET", "已達本次掃描的讀取上限。");
        meter.bytes += length;
      }
      const read = await handle.read(buffer, bytes, length, bytes);
      if (read.bytesRead === 0) break;
      if (bytes === 0 && buffer.subarray(0, read.bytesRead).includes(0)) throw binaryFile();
      bytes += read.bytesRead;
    }
    await recheck();
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
      throw changedFile();
    }
    const data = buffer.subarray(0, bytes);
    if (data.includes(0)) throw binaryFile();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw binaryFile();
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

/** The directory path must still name the same real directory that was resolved and listed. */
async function assertSameDirectory(directory: CheckedDirectory) {
  const current = await lstat(directory.path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== directory.dev ||
    current.ino !== directory.ino
  )
    throw changedFile();
}

/** Case-insensitive Bun glob; a pattern with / matches the relative path, otherwise the name. */
function globMatcher(pattern: string) {
  const glob = new Bun.Glob(pattern.toLowerCase());
  const byPath = pattern.includes("/");
  return (item: Pick<WalkItem, "relative" | "name">) =>
    glob.match((byPath ? item.relative : item.name).toLowerCase());
}

function clipLine(line: string) {
  return line.length > excerptLength ? `${line.slice(0, excerptLength)}…` : line;
}

function compareNames(a: Dirent, b: Dirent) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export class WorkspaceFiles {
  private readonly budget: FileScanBudget;
  constructor(
    private readonly registry: WorkspaceRegistry,
    budget: Partial<FileScanBudget> = {},
  ) {
    this.budget = {
      walkEntries: LIMITS.walkEntries,
      scanBytes: LIMITS.scanBytes,
      scanMilliseconds: LIMITS.scanMilliseconds,
      now: () => performance.now(),
      ...budget,
    };
  }

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
  ): Promise<TextFile> {
    validateRelativePath(relative);
    const root = this.registry.get(id);
    const target = await resolveChecked(root, relative);
    if (!(await lstat(target)).isFile())
      throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
    return readVerifiedText(target, byteLimit, async () => {
      await resolveChecked(root, relative);
    });
  }

  /** One file_read page whose content stays within `budget` UTF-8 bytes. */
  private async page(
    id: string,
    relative: string,
    startLine: number,
    maxLines: number,
    budget: number,
  ): Promise<{ result: FileResult; bytes: number }> {
    const file = await this.readText(id, relative);
    const lines = file.text.split(/\r?\n/);
    const selected: string[] = [];
    let bytes = 0;
    let index = startLine - 1;
    while (index < lines.length && selected.length < maxLines) {
      const line = lines[index] ?? "";
      const length = Buffer.byteLength(line) + 1;
      if (selected.length === 0 && length > LIMITS.responseBytes)
        throw new KairomesError("LINE_TOO_LONG", "單行內容超過輸出上限，請改用搜尋。");
      if (bytes + length > budget) break;
      selected.push(line);
      bytes += length;
      index++;
    }
    const truncated = index < lines.length;
    return {
      bytes,
      result: {
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
      },
    };
  }

  async read(id: string, relative: string, startLine = 1, maxLines = 150): Promise<FileResult> {
    return (await this.page(id, relative, startLine, maxLines, LIMITS.responseBytes)).result;
  }

  /**
   * Reads 1-8 files in order with the same checks and redaction as `read`. All pages share one
   * response budget, and a failing file becomes an inline error instead of failing the batch.
   */
  async readMany(
    id: string,
    files: ReadonlyArray<{ path: string; start_line?: number; max_lines?: number }>,
  ): Promise<FileReadManyResult> {
    if (files.length < 1 || files.length > LIMITS.readManyFiles)
      throw new KairomesError("FILE_LIMIT", "一次只能讀取 1 到 8 個檔案。");
    this.registry.get(id);
    let remaining: number = LIMITS.responseBytes;
    const entries: FileReadManyEntry[] = [];
    for (const file of files) {
      const startLine = file.start_line ?? 1;
      try {
        const { result, bytes } = await this.page(
          id,
          file.path,
          startLine,
          file.max_lines ?? 150,
          remaining,
        );
        remaining -= bytes;
        entries.push({
          status: "ok",
          path: result.path,
          content: result.content,
          version: result.version,
          start_line: result.start_line,
          total_lines: result.total_lines,
          next_line: result.next_line,
          truncated: result.truncated,
          redacted: result.redacted,
        });
      } catch (error) {
        entries.push({
          status: "error",
          path: file.path,
          start_line: startLine,
          error: publicError(error),
        });
      }
    }
    this.registry.get(id);
    return {
      kind: "file_read_many",
      workspace_id: id,
      files: entries,
      truncated: entries.some((entry) => entry.status === "ok" && entry.truncated),
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

  private expired(state: WalkState) {
    return this.budget.now() > state.deadline;
  }

  /**
   * Breadth-first, name-sorted walk below `scope`. Each directory is resolved with the same
   * link and private-name checks as file_read, listed, then re-verified before its entries are
   * used. Links, junctions, private names and unsupported names are never visited or followed.
   * `prepare` may start bounded work ahead of time inside one directory; `visit` still sees
   * entries strictly in order and returns false to stop early.
   */
  private async walk<T = never>(
    root: RootIdentity,
    scope: string,
    visit: (item: WalkItem, state: WalkState, prepared?: Settled<T>) => Promise<boolean> | boolean,
    prepare?: (item: WalkItem) => Promise<T> | undefined,
  ): Promise<WalkState> {
    const state: WalkState = {
      visited: 0,
      skipped: 0,
      truncated: false,
      deadline: this.budget.now() + this.budget.scanMilliseconds,
    };
    const queue = [scope];
    let first = true;
    while (queue.length > 0) {
      const relative = queue.shift() ?? "";
      const isScope = first;
      first = false;
      let directory: CheckedDirectory;
      const items: Dirent[] = [];
      let exhausted = false;
      try {
        const target = await resolveChecked(root, relative);
        const before = await lstat(target, { bigint: true });
        if (!before.isDirectory()) throw new KairomesError("NOT_DIRECTORY", "此路徑不是資料夾。");
        directory = { path: target, dev: before.dev, ino: before.ino };
        for await (const item of await opendir(target)) {
          if (state.visited >= this.budget.walkEntries || this.expired(state)) {
            exhausted = true;
            break;
          }
          state.visited++;
          items.push(item);
        }
        await assertSameDirectory(directory);
      } catch (error) {
        if (isScope) throw error;
        state.skipped++;
        continue;
      }
      items.sort(compareNames);
      const candidates: WalkItem[] = [];
      for (const item of items) {
        if (isPrivateName(item.name) || item.isSymbolicLink()) {
          state.skipped++;
          continue;
        }
        const itemPath = relative ? `${relative}/${item.name}` : item.name;
        try {
          validateRelativePath(itemPath);
        } catch {
          state.skipped++;
          continue;
        }
        if (item.isDirectory()) {
          if (itemPath.split("/").length < maxDepth) queue.push(itemPath);
          else state.truncated = true;
          candidates.push({ relative: itemPath, name: item.name, type: "directory", directory });
        } else if (item.isFile()) {
          candidates.push({ relative: itemPath, name: item.name, type: "file", directory });
        }
      }
      const pending: Array<Promise<Settled<T>> | undefined> = [];
      let started = 0;
      // Never return while prepared work still holds file handles.
      const drain = () => Promise.all(pending.slice(Math.max(0, started - prefetchWindow)));
      for (let index = 0; index < candidates.length; index++) {
        if (this.expired(state)) {
          state.truncated = true;
          await drain();
          return state;
        }
        for (
          ;
          prepare && started < Math.min(index + prefetchWindow, candidates.length);
          started++
        ) {
          const candidate = candidates[started];
          pending[started] = candidate
            ? prepare(candidate)?.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
              )
            : undefined;
        }
        const prepared = await pending[index];
        pending[index] = undefined;
        const candidate = candidates[index];
        if (candidate && !(await visit(candidate, state, prepared))) {
          await drain();
          return state;
        }
      }
      if (exhausted) {
        state.truncated = true;
        return state;
      }
    }
    return state;
  }

  async search(
    id: string,
    query: string,
    limit = 30,
    options: SearchOptions = {},
  ): Promise<SearchResult> {
    const scope = options.path ?? "";
    const caseSensitive = options.caseSensitive ?? false;
    const include = [...(options.include ?? [])];
    const contextLines = options.contextLines ?? 0;
    if (!query || query.length > LIMITS.patternLength)
      throw new KairomesError("INVALID_QUERY", "搜尋文字長度不正確。");
    if (
      include.length > LIMITS.searchIncludePatterns ||
      include.some(
        (pattern) => pattern.length > LIMITS.patternLength || !isSafeGlobPattern(pattern),
      )
    )
      throw new KairomesError("INVALID_PATTERN", "檔案樣式必須是工作區內的相對樣式。");
    if (
      !Number.isInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > LIMITS.searchContextLines
    )
      throw new KairomesError("INVALID_CONTEXT", "前後文行數必須介於 0 到 3。");
    const root = this.registry.get(id);
    const matchers = include.map(globMatcher);
    const result: SearchResult = {
      kind: "search",
      workspace_id: id,
      query,
      path: scope,
      case_sensitive: caseSensitive,
      include,
      context_lines: contextLines,
      matches: [],
      truncated: false,
      scanned_files: 0,
      skipped_files: 0,
    };
    const needle = caseSensitive ? query : query.toLocaleLowerCase();
    const meter: ByteMeter = { bytes: 0, limit: this.budget.scanBytes };
    let outputBytes = 0;
    const read = (item: WalkItem) =>
      item.type === "file" && (matchers.length === 0 || matchers.some((matches) => matches(item)))
        ? readVerifiedText(
            path.join(item.directory.path, item.name),
            LIMITS.fileBytes,
            () => assertSameDirectory(item.directory),
            meter,
          )
        : undefined;
    const visit = (item: WalkItem, walk: WalkState, prepared?: Settled<TextFile>) => {
      if (!prepared) return true;
      if ("error" in prepared) {
        if (isScanBudget(prepared.error)) {
          walk.truncated = true;
          return false;
        }
        walk.skipped++;
        return true;
      }
      const file = prepared.value;
      result.scanned_files++;
      const lines = file.text.split(/\r?\n/);
      // A final newline does not start another line of context.
      const lastLine = lines.length - (lines.at(-1) === "" ? 1 : 0);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const matchIndex = (caseSensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
        if (matchIndex < 0) continue;
        const start = Math.max(0, matchIndex - 100);
        const match: SearchResult["matches"][number] = {
          path: item.relative,
          line: i + 1,
          text: `${start > 0 ? "…" : ""}${line.slice(start, start + excerptLength)}${line.length > start + excerptLength ? "…" : ""}`,
        };
        if (contextLines > 0) {
          match.before = lines.slice(Math.max(0, i - contextLines), i).map(clipLine);
          match.after = lines.slice(i + 1, Math.min(lastLine, i + 1 + contextLines)).map(clipLine);
        }
        const size = Buffer.byteLength(JSON.stringify(match));
        if (outputBytes + size > LIMITS.responseBytes) {
          walk.truncated = true;
          return false;
        }
        outputBytes += size;
        result.matches.push(match);
        if (result.matches.length >= limit) {
          walk.truncated = true;
          return false;
        }
      }
      return true;
    };
    const state = await this.walk(root, scope, visit, read);
    result.truncated = state.truncated;
    result.skipped_files = state.skipped;
    await resolveChecked(root, scope);
    this.registry.get(id);
    return result;
  }

  /**
   * Finds files and directories by name without reading file contents. A query with *, ? or {
   * is a case-insensitive glob; otherwise a case-insensitive substring. A query with / is
   * matched against the workspace-relative path, otherwise against the entry name.
   */
  async find(id: string, query: string, scope = "", limit = 50): Promise<FileFindResult> {
    const mode = isGlobQuery(query) ? "glob" : "substring";
    if (
      !query ||
      query.length > LIMITS.patternLength ||
      (mode === "glob" && !isSafeGlobPattern(query))
    )
      throw new KairomesError("INVALID_PATTERN", "檔名樣式必須是工作區內的相對樣式。");
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.findResults)
      throw new KairomesError("INVALID_LIMIT", "結果數量必須介於 1 到 200。");
    const root = this.registry.get(id);
    const byPath = query.includes("/");
    const needle = query.toLowerCase();
    const matches =
      mode === "glob"
        ? globMatcher(query)
        : (item: WalkItem) => (byPath ? item.relative : item.name).toLowerCase().includes(needle);
    const result: FileFindResult = {
      kind: "file_find",
      workspace_id: id,
      query,
      mode,
      path: scope,
      entries: [],
      truncated: false,
      scanned_entries: 0,
    };
    let outputBytes = 0;
    const state = await this.walk(root, scope, (item, walk) => {
      if (!matches(item)) return true;
      const size = Buffer.byteLength(JSON.stringify(item.relative)) + 32;
      if (outputBytes + size > LIMITS.responseBytes) {
        walk.truncated = true;
        return false;
      }
      outputBytes += size;
      result.entries.push({ path: item.relative, type: item.type });
      if (result.entries.length >= limit) {
        walk.truncated = true;
        return false;
      }
      return true;
    });
    result.truncated = state.truncated;
    result.scanned_entries = state.visited;
    await resolveChecked(root, scope);
    this.registry.get(id);
    return result;
  }
}
