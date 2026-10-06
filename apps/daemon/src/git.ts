import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  GIT_LIMITS,
  type GitCommit,
  type GitDiff,
  type GitDiffFile,
  type GitLog,
  type GitStatus,
  type GitStatusEntry,
  type GitUnavailableReason,
  KairomesError,
} from "@kairomes/protocol";
import {
  redactKnownSecrets,
  resolveChecked,
  validateRelativePath,
  type WorkspaceRegistry,
} from "@kairomes/workspace-core";

export const GIT_TIMEOUT_MS = 5000;
export const GIT_OUTPUT_BYTES = 256 * 1024;
export const GIT_DIFF_BYTES = 1024 * 1024;

const NULL_HOOKS = process.platform === "win32" ? "NUL" : "/dev/null";
/**
 * Repository configuration is untrusted. Every invocation disables configured programs
 * (fsmonitor, hooks, external diff, signature verification, transports), pagers, colour,
 * path quoting and optional index writes before any per-command arguments.
 */
const GLOBAL_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=false",
  "-c",
  `core.hooksPath=${NULL_HOOKS}`,
  "-c",
  "protocol.allow=never",
  "-c",
  "log.showSignature=false",
  "-c",
  "log.follow=false",
  "-c",
  "status.submoduleSummary=false",
  "--no-pager",
  "--no-optional-locks",
] as const;
const ENVIRONMENT_ALLOWLIST = /^(path|home|userprofile|systemroot|windir|temp|tmp|lang)$/i;
/** Filter driver names are passed back through -c; anything unusual fails closed. */
const FILTER_DRIVER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MAX_FILTER_DRIVERS = 32;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHORT_SHA = /^[0-9a-f]{4,64}$/;
const MAX_PATCH_FILES = 1000;
const MAX_PATCH_BATCHES = 8;
const PATCH_PHASE_MS = 10_000;
/** Conservative per-process pathspec budget that stays below the Windows command-line limit. */
const PATHSPEC_CHARS = 16_000;
const FILE_LIST_BYTES = 16 * 1024;
const STATUS_BYTES = GIT_LIMITS.diffPageBytes - 4096;
const DIFF_STATUSES = new Set(["A", "C", "D", "M", "R", "T", "U"]);
const STATUS_CODES = new Set([".", "M", "T", "A", "D", "R", "C", "U", "?"]);

const unavailableMessages: Record<GitUnavailableReason, string> = {
  not_repository: "此工作區不是 Git 儲存庫，或 Git 拒絕讀取。",
  root_mismatch: "Git 儲存庫根目錄與工作區不同；未讀取工作區以外的狀態。",
  git_missing: "找不到 Git；請先在本機安裝 Git。",
  timeout: "Git 讀取逾時。",
  too_large: "Git 輸出超過上限；請用 path 縮小範圍。",
  unsupported_config: "此儲存庫的 filter 設定無法安全停用，未執行 Git。",
  failed: "Git 讀取失敗。",
};

export type GitOutcome =
  | { kind: "ok"; stdout: Buffer }
  | { kind: "overflow"; stdout: Buffer }
  | { kind: "failed"; exitCode: number | null }
  | { kind: "timeout" }
  | { kind: "missing" };

type RunOptions = {
  maxBuffer?: number;
  timeoutMs?: number;
  /** Extra `-c key=value` pairs placed after the fixed global flags. */
  config?: readonly string[];
  /** Directory that Git must not search above; defaults to the parent of cwd. */
  ceiling?: string;
};

/** Minimal environment: no inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_CONFIG_* or pager. */
export function gitEnvironment(
  ceiling: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value && ENVIRONMENT_ALLOWLIST.test(name)) env[name] = value;
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
    GIT_CEILING_DIRECTORIES: ceiling,
  };
}

/** The single Git runner: fixed argv, no shell, hidden window, bounded time and output. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<GitOutcome> {
  const maxBuffer = options.maxBuffer ?? GIT_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: GitOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawn("git", [...GLOBAL_ARGS, ...(options.config ?? []), ...args], {
        cwd,
        env: gitEnvironment(options.ceiling ?? path.dirname(cwd)),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      settle(missingOrFailed(error));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    // Settle at once on timeout or overflow; an inherited pipe must not keep the call alive.
    const stop = (outcome: GitOutcome) => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      settle(outcome);
    };
    timer = setTimeout(() => stop({ kind: "timeout" }), options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      const room = maxBuffer - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        stop({ kind: "overflow", stdout: Buffer.concat(chunks, maxBuffer) });
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stdout?.on("error", () => undefined);
    child.on("error", (error) => settle(missingOrFailed(error)));
    child.on("close", (code) => {
      if (code !== 0) settle({ kind: "failed", exitCode: code });
      else settle({ kind: "ok", stdout: Buffer.concat(chunks, size) });
    });
  });
}

function missingOrFailed(error: unknown): GitOutcome {
  return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
    ? { kind: "missing" }
    : { kind: "failed", exitCode: null };
}

function outcomeReason(outcome: GitOutcome, fallback: GitUnavailableReason): GitUnavailableReason {
  if (outcome.kind === "missing") return "git_missing";
  if (outcome.kind === "timeout") return "timeout";
  if (outcome.kind === "overflow") return "too_large";
  return fallback;
}

export type GitRepository = {
  /** Canonical repository root; never returned to the model. */
  root: string;
  run(args: readonly string[], options?: { maxBuffer?: number }): Promise<GitOutcome>;
};
export type GitAvailability =
  | { state: "available"; repository: GitRepository }
  | { state: "unavailable"; reason: GitUnavailableReason };

/**
 * Opens a repository only when `git rev-parse --show-toplevel` resolves to exactly the given
 * directory. Configured filter drivers are neutralised for every later command, because a clean
 * or process filter would otherwise run whenever status or diff rehashes a working-tree file.
 */
export async function openGitRepository(directory: string): Promise<GitAvailability> {
  const root = await realpath(directory).catch(() => null);
  if (!root) return { state: "unavailable", reason: "not_repository" };
  const ceiling = path.dirname(root);
  const toplevel = await runGit(root, ["rev-parse", "--show-toplevel"], { ceiling });
  if (toplevel.kind !== "ok")
    return { state: "unavailable", reason: outcomeReason(toplevel, "not_repository") };
  const reported = toplevel.stdout.toString("utf8").replace(/\r?\n$/, "");
  const canonical = reported ? await realpath(reported).catch(() => null) : null;
  if (!canonical || path.relative(root, canonical) !== "")
    return { state: "unavailable", reason: "root_mismatch" };
  const filters = await runGit(root, ["config", "-z", "--get-regexp", "^filter\\."], { ceiling });
  const drivers = new Set<string>();
  if (filters.kind === "ok") {
    for (const record of filters.stdout.toString("utf8").split("\0")) {
      const key = record.split("\n", 1)[0] ?? "";
      if (!key.startsWith("filter.")) continue;
      const rest = key.slice("filter.".length);
      const end = rest.lastIndexOf(".");
      if (end <= 0) continue;
      const name = rest.slice(0, end);
      if (!FILTER_DRIVER.test(name)) return { state: "unavailable", reason: "unsupported_config" };
      drivers.add(name);
    }
  } else if (!(filters.kind === "failed" && filters.exitCode === 1)) {
    // Exit code 1 only means that no filter key exists.
    return { state: "unavailable", reason: outcomeReason(filters, "failed") };
  }
  if (drivers.size > MAX_FILTER_DRIVERS)
    return { state: "unavailable", reason: "unsupported_config" };
  const config = [...drivers].flatMap((name) => [
    "-c",
    `filter.${name}.clean=`,
    "-c",
    `filter.${name}.smudge=`,
    "-c",
    `filter.${name}.process=`,
    "-c",
    `filter.${name}.required=false`,
  ]);
  return {
    state: "available",
    repository: {
      root,
      run: (args, options = {}) =>
        runGit(root, args, { config, ceiling, maxBuffer: options.maxBuffer }),
    },
  };
}

/** NUL-terminated records; an unterminated tail (cut output) is discarded. */
function records(stdout: Buffer) {
  const tokens = stdout.toString("utf8").split("\0");
  tokens.pop();
  return tokens;
}

/** Same policy as file_read: relative, no traversal, no private or unsupported names. */
function publicPath(value: string | undefined) {
  if (!value || value.includes("\uFFFD")) return undefined;
  try {
    validateRelativePath(value);
    return value;
  } catch {
    return undefined;
  }
}

function clip(value: string, length: number) {
  if (value.length <= length) return value;
  let end = length;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return value.slice(0, end);
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function literal(relative: string) {
  return `:(literal)${relative}`;
}

/** Page text by JSON-encoded bytes, ending on a line boundary unless one line exceeds the page. */
export function pageText(text: string, start: number, budget: number) {
  let end = start;
  let used = 0;
  while (end < text.length) {
    const newline = text.indexOf("\n", end);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const size = jsonBytes(text.slice(end, lineEnd)) - 2;
    if (used + size <= budget) {
      used += size;
      end = lineEnd;
      continue;
    }
    if (end > start) break;
    for (const character of text.slice(end, lineEnd)) {
      const characterSize = jsonBytes(character) - 2;
      if (used + characterSize > budget) break;
      used += characterSize;
      end += character.length;
    }
    break;
  }
  return { text: text.slice(start, end), end };
}

type ListedFile = {
  status: string;
  path: string;
  previous?: string;
  link: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
};

/** Parses `git diff[-files] --raw --numstat -z`. Any unexpected token rejects the whole listing. */
export function parseDiffListing(stdout: Buffer): ListedFile[] | undefined {
  const tokens = stdout.toString("utf8").split("\0");
  if (tokens.pop() !== "") return undefined;
  const raw: Omit<ListedFile, "additions" | "deletions" | "binary">[] = [];
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token.startsWith(":")) {
      const fields = token.slice(1).split(" ");
      const [sourceMode, targetMode, , , status] = fields;
      if (fields.length !== 5 || !status) return undefined;
      const letter = status.charAt(0);
      const link = [sourceMode, targetMode].some((mode) => mode === "120000" || mode === "160000");
      if (letter === "R" || letter === "C") {
        const previous = tokens[++index];
        const next = tokens[++index];
        if (previous === undefined || next === undefined) return undefined;
        raw.push({ status: letter, path: next, previous, link });
      } else {
        const next = tokens[++index];
        if (next === undefined) return undefined;
        raw.push({ status: letter, path: next, link });
      }
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(token);
    if (!match) return undefined;
    let next: string | undefined = token.slice(match[0].length);
    if (next === "") {
      index++;
      next = tokens[++index];
      if (next === undefined) return undefined;
    }
    const binary = match[1] === "-" || match[2] === "-";
    if (!stats.has(next))
      stats.set(next, {
        additions: binary ? 0 : Number(match[1]),
        deletions: binary ? 0 : Number(match[2]),
        binary,
      });
  }
  const seen = new Set<string>();
  const files: ListedFile[] = [];
  for (const file of raw) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    const stat = stats.get(file.path);
    // diff-files reports stat-only differences in --raw; numstat omits identical content.
    if (!stat && file.status === "M") continue;
    files.push({ ...file, ...(stat ?? { additions: 0, deletions: 0, binary: false }) });
  }
  return files;
}

function unavailable(reason: GitUnavailableReason) {
  return {
    state: "unavailable" as const,
    reason,
    message: unavailableMessages[reason],
  };
}
const available = { state: "available" as const, reason: null, message: null };

/** Read-only Git views for mounted workspaces; roots come from the registry, never from input. */
export class WorkspaceGit {
  constructor(private readonly registry: WorkspaceRegistry) {}

  private async open(id: string, relative?: string) {
    const row = this.registry.get(id);
    if (relative !== undefined) validateRelativePath(relative);
    await resolveChecked(row, "");
    return openGitRepository(row.root);
  }

  async status(id: string): Promise<GitStatus> {
    const base: GitStatus = {
      kind: "git_status",
      workspace_id: id,
      ...available,
      branch: null,
      detached: false,
      head: null,
      upstream: null,
      entries: [],
      truncated: false,
      omitted_private: 0,
    };
    const opened = await this.open(id);
    if (opened.state === "unavailable") return { ...base, ...unavailable(opened.reason) };
    const repository = opened.repository;
    const status = await repository.run([
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=dirty",
      "--renames",
    ]);
    if (status.kind !== "ok" && status.kind !== "overflow")
      return { ...base, ...unavailable(outcomeReason(status, "failed")) };
    const tokens = records(status.stdout);
    const result: GitStatus = { ...base, truncated: status.kind === "overflow" };
    let oid: string | undefined;
    let bytes = 0;
    let capped = false;
    for (let index = 0; index < tokens.length; index++) {
      const record = tokens[index] ?? "";
      if (record.startsWith("# ")) {
        const [key, ...values] = record.slice(2).split(" ");
        const value = values.join(" ");
        if (key === "branch.oid") oid = value;
        else if (key === "branch.head") {
          result.detached = value === "(detached)";
          result.branch = result.detached || !value ? null : clip(value, GIT_LIMITS.refLength);
        } else if (key === "branch.upstream" && value)
          result.upstream = { name: clip(value, GIT_LIMITS.refLength), ahead: null, behind: null };
        else if (key === "branch.ab" && result.upstream) {
          const counts = /^\+(\d+) -(\d+)$/.exec(value);
          if (counts) {
            result.upstream.ahead = Number(counts[1]);
            result.upstream.behind = Number(counts[2]);
          }
        }
        continue;
      }
      const type = record.charAt(0);
      let fields: string[] = [];
      let current: string | undefined;
      let previous: string | undefined;
      if (type === "1" || type === "2" || type === "u") {
        const count = type === "1" ? 8 : type === "2" ? 9 : 10;
        const parts = record.split(" ");
        fields = parts.slice(0, count);
        current = parts.slice(count).join(" ");
        if (type === "2") {
          previous = tokens[++index];
          if (previous === undefined) {
            result.truncated = true;
            break;
          }
        }
      } else if (type === "?") {
        current = record.slice(2).replace(/\/$/, "");
        fields = ["?", "??"];
      } else continue;
      const code = fields[1] ?? "";
      const indexStatus = type === "?" ? "?" : code.charAt(0);
      const worktreeStatus = type === "?" ? "?" : code.charAt(1);
      const publicCurrent = publicPath(current);
      if (
        !publicCurrent ||
        (previous !== undefined && !publicPath(previous)) ||
        !STATUS_CODES.has(indexStatus) ||
        !STATUS_CODES.has(worktreeStatus)
      ) {
        result.omitted_private++;
        continue;
      }
      // Keep counting omitted paths after the entry cap; only the list itself is bounded.
      if (capped) continue;
      const entry: GitStatusEntry = {
        path: publicCurrent,
        ...(previous !== undefined ? { previous_path: previous } : {}),
        index_status: indexStatus as GitStatusEntry["index_status"],
        worktree_status: worktreeStatus as GitStatusEntry["worktree_status"],
        kind:
          type === "u"
            ? "conflict"
            : type === "?"
              ? "untracked"
              : indexStatus !== "."
                ? "staged"
                : "unstaged",
      };
      const size = jsonBytes(entry) + 1;
      if (result.entries.length >= GIT_LIMITS.statusEntries || bytes + size > STATUS_BYTES) {
        capped = true;
        result.truncated = true;
        continue;
      }
      bytes += size;
      result.entries.push(entry);
    }
    if (oid && oid !== "(initial)") {
      if (!SHA.test(oid)) return { ...base, ...unavailable("failed") };
      const head = await repository.run([
        "log",
        "-1",
        "-z",
        "--no-show-signature",
        "--no-color",
        "--no-notes",
        "--encoding=UTF-8",
        "--format=%h%x00%s",
        oid,
        "--",
      ]);
      const [shortSha, subject] = head.kind === "ok" ? records(head.stdout) : [];
      if (!shortSha || !SHORT_SHA.test(shortSha) || subject === undefined)
        return { ...base, ...unavailable(outcomeReason(head, "failed")) };
      result.head = {
        sha: oid,
        short_sha: shortSha,
        subject: clip(redactKnownSecrets(subject), GIT_LIMITS.subjectLength),
      };
    }
    this.registry.get(id);
    return result;
  }

  async log(input: { workspace_id: string; path?: string; limit: number }): Promise<GitLog> {
    const base: GitLog = {
      kind: "git_log",
      workspace_id: input.workspace_id,
      ...available,
      path: input.path ?? null,
      commits: [],
      has_more: false,
    };
    const opened = await this.open(input.workspace_id, input.path);
    if (opened.state === "unavailable") return { ...base, ...unavailable(opened.reason) };
    const repository = opened.repository;
    const head = await repository.run(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    // An unborn branch has no history yet; that is an available, empty log.
    if (head.kind === "failed" && head.exitCode === 1) return base;
    if (head.kind !== "ok") return { ...base, ...unavailable(outcomeReason(head, "failed")) };
    const log = await repository.run([
      "log",
      `--max-count=${input.limit + 1}`,
      "-z",
      "--no-show-signature",
      "--no-color",
      "--no-notes",
      "--encoding=UTF-8",
      "--format=%H%x00%h%x00%an%x00%aI%x00%s",
      "HEAD",
      "--",
      ...(input.path ? [literal(input.path)] : []),
    ]);
    if (log.kind !== "ok" && log.kind !== "overflow")
      return { ...base, ...unavailable(outcomeReason(log, "failed")) };
    const tokens = records(log.stdout);
    const commits: GitCommit[] = [];
    for (let index = 0; index + 5 <= tokens.length; index += 5) {
      const [sha, shortSha, author, authoredAt, subject] = tokens.slice(index, index + 5);
      if (!sha || !SHA.test(sha) || !shortSha || !SHORT_SHA.test(shortSha)) {
        return { ...base, ...unavailable("failed") };
      }
      commits.push({
        sha,
        short_sha: shortSha,
        author_name: clip(redactKnownSecrets(author ?? ""), GIT_LIMITS.nameLength),
        authored_at: clip(authoredAt ?? "", 40),
        subject: clip(redactKnownSecrets(subject ?? ""), GIT_LIMITS.subjectLength),
      });
    }
    this.registry.get(input.workspace_id);
    return {
      ...base,
      commits: commits.slice(0, input.limit),
      has_more: commits.length > input.limit || log.kind === "overflow",
    };
  }

  async diff(input: {
    workspace_id: string;
    path?: string;
    staged: boolean;
    context_lines: number;
    cursor?: string;
  }): Promise<GitDiff> {
    const base: GitDiff = {
      kind: "git_diff",
      workspace_id: input.workspace_id,
      ...available,
      staged: input.staged,
      path: input.path ?? null,
      context_lines: input.context_lines,
      files: [],
      files_truncated: false,
      omitted_private: 0,
      diff: "",
      next_cursor: null,
      has_more: false,
      truncated: false,
      redacted: false,
    };
    const opened = await this.open(input.workspace_id, input.path);
    if (opened.state === "unavailable") return { ...base, ...unavailable(opened.reason) };
    const repository = opened.repository;
    // Porcelain `git diff` refreshes and rewrites .git/index for stat-dirty files, so the working
    // tree side uses plumbing diff-files; `diff --cached` never compares stat data.
    const common = [
      ...(input.staged ? ["diff", "--cached"] : ["diff-files"]),
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--submodule=short",
      "--ignore-submodules=dirty",
      "-M",
    ];
    // List first, then diff only paths that pass the same policy as file_read.
    const listing = await repository.run(
      [...common, "--raw", "--numstat", "-z", "--", ...(input.path ? [literal(input.path)] : [])],
      { maxBuffer: GIT_DIFF_BYTES },
    );
    if (listing.kind !== "ok") return { ...base, ...unavailable(outcomeReason(listing, "failed")) };
    const listed = parseDiffListing(listing.stdout);
    if (!listed) return { ...base, ...unavailable("failed") };
    let omitted = 0;
    const allowed: (GitDiffFile & { pathspecs: string[] })[] = [];
    for (const file of listed) {
      const current = publicPath(file.path);
      if (
        file.link ||
        !current ||
        (file.previous !== undefined && !publicPath(file.previous)) ||
        !DIFF_STATUSES.has(file.status)
      ) {
        omitted++;
        continue;
      }
      allowed.push({
        path: current,
        ...(file.previous !== undefined ? { previous_path: file.previous } : {}),
        status: file.status as GitDiffFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
        pathspecs: [
          literal(current),
          ...(file.previous !== undefined ? [literal(file.previous)] : []),
        ],
      });
    }
    const patchArgs = [
      ...common,
      `--unified=${input.context_lines}`,
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
    ];
    const candidates = allowed.slice(0, MAX_PATCH_FILES);
    let truncated = allowed.length > candidates.length;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let batches = 0;
    let index = 0;
    const deadline = Date.now() + PATCH_PHASE_MS;
    while (index < candidates.length) {
      if (batches >= MAX_PATCH_BATCHES || bytes >= GIT_DIFF_BYTES || Date.now() > deadline) {
        truncated = true;
        break;
      }
      const pathspecs: string[] = [];
      let characters = 0;
      while (index < candidates.length) {
        const specs = candidates[index]?.pathspecs ?? [];
        const size = specs.reduce((total, spec) => total + spec.length + 3, 0);
        if (pathspecs.length > 0 && characters + size > PATHSPEC_CHARS) break;
        pathspecs.push(...specs);
        characters += size;
        index++;
      }
      batches++;
      const patch = await repository.run([...patchArgs, ...pathspecs], {
        maxBuffer: GIT_DIFF_BYTES - bytes,
      });
      if (patch.kind === "ok" || patch.kind === "overflow") {
        chunks.push(patch.stdout);
        bytes += patch.stdout.length;
      }
      if (patch.kind === "overflow") {
        truncated = true;
        break;
      }
      if (patch.kind !== "ok") return { ...base, ...unavailable(outcomeReason(patch, "failed")) };
    }
    const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks, bytes));
    const safe = redactKnownSecrets(text);
    const digest = createHash("sha256")
      .update(JSON.stringify([input.staged, input.path ?? null, input.context_lines]))
      .update("\0")
      .update(safe)
      .digest("hex")
      .slice(0, 16);
    let offset = 0;
    if (input.cursor) {
      const [position, expected] = input.cursor.split(".");
      if (expected !== digest)
        throw new KairomesError(
          "GIT_DIFF_CHANGED",
          "Git 差異在分頁之間已改變；請不帶 cursor 重新讀取第一頁。",
        );
      offset = Number(position);
      if (!Number.isSafeInteger(offset) || offset > safe.length)
        throw new KairomesError("INVALID_CURSOR", "分頁位置不正確；請不帶 cursor 重新讀取。");
    }
    const files: GitDiffFile[] = [];
    let filesTruncated = false;
    let fileBytes = 0;
    for (const { pathspecs: _pathspecs, ...file } of allowed) {
      const size = jsonBytes(file) + 1;
      if (files.length >= GIT_LIMITS.diffFiles || fileBytes + size > FILE_LIST_BYTES) {
        filesTruncated = true;
        break;
      }
      fileBytes += size;
      files.push(file);
    }
    const response: GitDiff = {
      ...base,
      files,
      files_truncated: filesTruncated,
      omitted_private: omitted,
      truncated,
      redacted: safe !== text,
    };
    const envelope = jsonBytes({ ...response, next_cursor: `99999999.${digest}`, has_more: true });
    const page = pageText(safe, offset, GIT_LIMITS.diffPageBytes - envelope - 64);
    const hasMore = page.end < safe.length;
    this.registry.get(input.workspace_id);
    return {
      ...response,
      diff: page.text,
      has_more: hasMore,
      next_cursor: hasMore ? `${page.end}.${digest}` : null,
    };
  }
}
