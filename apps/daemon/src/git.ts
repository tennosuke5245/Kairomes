import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
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
 * (fsmonitor, hooks, external diff, signature verification, transports), submodule recursion,
 * pagers, colour, path quoting and optional index writes before any per-command arguments.
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
  "-c",
  "submodule.recurse=false",
  "--no-pager",
  "--no-optional-locks",
] as const;
const ENVIRONMENT_ALLOWLIST = /^(path|home|userprofile|systemroot|windir|temp|tmp|lang)$/i;
/**
 * GIT_ALLOW_PROTOCOL overrides every protocol.*.allow key, including per-protocol keys in the
 * repository config that outrank `-c protocol.allow=never`. Only this name is allowed; `<` and
 * `>` cannot appear in a URL scheme or in a Windows file name, so no transport or helper matches.
 */
const NO_PROTOCOL = "<none>";
/** Filter driver names are passed back through -c; anything unusual fails closed. */
const FILTER_DRIVER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MAX_FILTER_DRIVERS = 32;
/**
 * Config keys that decide which programs Git may start: filter drivers, Git LFS extensions (run by
 * the LFS clean filter) and partial-clone promisor remotes (lazy fetches start a transport).
 */
const PROGRAM_CONFIG =
  "^(filter\\.|lfs\\.extension\\.|extensions\\.partialclone$|remote\\..*\\.promisor$)";
/** Scopes the local user controls. Repository, worktree and command scopes are untrusted. */
const TRUSTED_SCOPES = new Set(["system", "global"]);
/** Git directory entries these views never read through, or that only hold loose objects. */
const UNREAD_GIT_ENTRIES = new Set(["hooks", "lfs", "logs", "modules", "rr-cache", "worktrees"]);
const MAX_GIT_DIRECTORY_ENTRIES = 50_000;
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
  unsupported_config:
    "此儲存庫的設定無法安全停用（例如 filter 名稱、partial clone、替代物件庫或 .git 內的連結），未執行 Git。",
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
  /** Replaces the minimal environment; tests use it to emulate other hosts. */
  environment?: Record<string, string>;
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
    GIT_ALLOW_PROTOCOL: NO_PROTOCOL,
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
        env: options.environment ?? gitEnvironment(options.ceiling ?? path.dirname(cwd)),
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
type Runner = (args: readonly string[], options?: RunOptions) => Promise<GitOutcome>;

function firstLine(outcome: GitOutcome) {
  return outcome.kind === "ok" ? outcome.stdout.toString("utf8").replace(/\r?\n$/, "") : "";
}

/**
 * The repository must be this checkout's own: a real `.git` directory that is both the Git
 * directory and the common directory, or a `.git` file of a linked worktree or submodule whose
 * Git directory points back at this checkout. A crafted gitfile, `commondir`, alternates file or
 * symbolic link would otherwise let the views read another repository on the computer.
 */
async function repositoryLayoutReason(
  root: string,
  gitDir: string,
  commonDir: string,
  run: Runner,
): Promise<GitUnavailableReason | undefined> {
  const dotGit = path.join(root, ".git");
  const [entry, own, git, common] = await Promise.all([
    lstat(dotGit).catch(() => null),
    realpath(dotGit).catch(() => null),
    realpath(path.resolve(root, gitDir)).catch(() => null),
    realpath(path.resolve(root, commonDir)).catch(() => null),
  ]);
  if (!entry || !own || !git || !common) return "root_mismatch";
  if (entry.isDirectory()) {
    if (git !== own || common !== own) return "root_mismatch";
  } else if (!entry.isFile()) {
    return "root_mismatch";
  } else if (git !== common) {
    // Linked worktree: <common>/worktrees/<name>/gitdir names this checkout's .git file.
    if (path.dirname(git) !== path.join(common, "worktrees")) return "root_mismatch";
    const back = await readFile(path.join(git, "gitdir"), "utf8").catch(() => "");
    const target = back.replace(/\r?\n$/, "");
    if (!target || (await realpath(path.resolve(git, target)).catch(() => null)) !== own)
      return "root_mismatch";
  } else {
    // Submodule: its own Git directory sets core.worktree to this checkout.
    const target = firstLine(
      await run(["config", "--file", path.join(git, "config"), "--get", "core.worktree"]),
    );
    if (!target || (await realpath(path.resolve(git, target)).catch(() => null)) !== root)
      return "root_mismatch";
  }
  const state = { entries: 0 };
  for (const directory of git === common ? [git] : [common, git]) {
    const reason = await gitDirectoryLinkReason(directory, state);
    if (reason) return reason;
  }
  return undefined;
}

function missingEntry(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/**
 * Git follows symbolic links and junctions inside its directory (for example `refs` or
 * `objects/pack`), and alternates add another object store, so either one could pull in another
 * repository's history. Loose object fan-out directories are checked themselves, not walked.
 */
async function gitDirectoryLinkReason(
  top: string,
  state: { entries: number },
): Promise<GitUnavailableReason | undefined> {
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop() ?? "";
    const directory = relative ? path.join(top, relative) : top;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      handle = await opendir(directory);
    } catch (error) {
      // Git may remove lock files and emptied directories while the walk runs.
      if (relative && missingEntry(error)) continue;
      return "failed";
    }
    for await (const entry of handle) {
      if (++state.entries > MAX_GIT_DIRECTORY_ENTRIES) return "too_large";
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === "objects/info/alternates") return "unsupported_config";
      let directoryEntry = entry.isDirectory();
      if (!directoryEntry && !entry.isFile()) {
        // Links, junctions, other reparse points and unknown types: inspect without following.
        const info = await lstat(path.join(directory, entry.name)).catch((error) =>
          missingEntry(error) ? undefined : null,
        );
        if (info === undefined) continue;
        if (!info || info.isSymbolicLink()) return "unsupported_config";
        directoryEntry = info.isDirectory();
      }
      if (!directoryEntry) continue;
      if (!relative && UNREAD_GIT_ENTRIES.has(entry.name)) continue;
      if (relative === "objects" && /^[0-9a-f]{2}$/.test(entry.name)) continue;
      pending.push(child);
    }
  }
  return undefined;
}

/**
 * Filter drivers defined only in system or global config belong to the local user (for example
 * Git LFS) and keep working, so status and diff match plain Git. A driver with any key from the
 * repository, a worktree or the command line is neutralised, because its clean or process filter
 * would run whenever status or diff rehashes a working-tree file. LFS extensions configured by
 * the repository run inside the LFS clean filter, so they neutralise every driver. Partial clones
 * and promisor remotes are refused: a missing object would start a lazy fetch through a transport.
 */
async function filterPolicy(run: Runner): Promise<{ config: string[] } | GitUnavailableReason> {
  let scoped = true;
  let listing = await run(["config", "-z", "--show-scope", "--get-regexp", PROGRAM_CONFIG]);
  if (listing.kind === "failed" && listing.exitCode === 129) {
    // Git before 2.26 has no --show-scope; every driver then counts as repository-defined.
    scoped = false;
    listing = await run(["config", "-z", "--get-regexp", PROGRAM_CONFIG]);
  }
  // Exit code 1 only means that no matching key exists.
  if (listing.kind === "failed" && listing.exitCode === 1) return { config: [] };
  if (listing.kind !== "ok") return outcomeReason(listing, "failed");
  const tokens = records(listing.stdout);
  const drivers = new Set<string>();
  const repositoryDrivers = new Set<string>();
  let distrustAll = !scoped;
  for (let index = 0; index < tokens.length; index++) {
    const scope = scoped ? tokens[index++] : undefined;
    const key = (tokens[index] ?? "").split("\n", 1)[0] ?? "";
    const trusted = scope !== undefined && TRUSTED_SCOPES.has(scope);
    if (key === "extensions.partialclone" || /^remote\..*\.promisor$/s.test(key))
      return "unsupported_config";
    if (key.startsWith("lfs.extension.")) {
      if (!trusted) distrustAll = true;
      continue;
    }
    const rest = key.startsWith("filter.") ? key.slice("filter.".length) : "";
    const end = rest.lastIndexOf(".");
    if (end <= 0) continue;
    const name = rest.slice(0, end);
    if (!FILTER_DRIVER.test(name)) return "unsupported_config";
    drivers.add(name);
    if (!trusted) repositoryDrivers.add(name);
  }
  if (drivers.size > MAX_FILTER_DRIVERS) return "unsupported_config";
  return {
    config: [...(distrustAll ? drivers : repositoryDrivers)].flatMap((name) => [
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ]),
  };
}

/**
 * Opens a repository only when Git resolves exactly the given directory as the work tree, the
 * repository data belongs to that checkout, and no repository-configured program can run.
 */
export async function openGitRepository(
  directory: string,
  options: { environment?: Record<string, string> } = {},
): Promise<GitAvailability> {
  const root = await realpath(directory).catch(() => null);
  if (!root) return { state: "unavailable", reason: "not_repository" };
  const base = { ceiling: path.dirname(root), environment: options.environment };
  const run: Runner = (args, extra = {}) => runGit(root, args, { ...base, ...extra });
  const probe = await run([
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--git-common-dir",
  ]);
  if (probe.kind !== "ok")
    return { state: "unavailable", reason: outcomeReason(probe, "not_repository") };
  const lines = probe.stdout.toString("utf8").split(/\r?\n/);
  const [reported, gitDir, commonDir] = lines;
  if (lines.length !== 4 || lines[3] !== "" || !reported || !gitDir || !commonDir)
    return { state: "unavailable", reason: "root_mismatch" };
  const canonical = await realpath(reported).catch(() => null);
  if (!canonical || path.relative(root, canonical) !== "")
    return { state: "unavailable", reason: "root_mismatch" };
  const layout = await repositoryLayoutReason(root, gitDir, commonDir, run);
  if (layout) return { state: "unavailable", reason: layout };
  const policy = await filterPolicy(run);
  if (typeof policy === "string") return { state: "unavailable", reason: policy };
  return {
    state: "available",
    repository: {
      root,
      run: (args, extra = {}) => run(args, { config: policy.config, maxBuffer: extra.maxBuffer }),
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
  if (!value || value.length > GIT_LIMITS.pathLength || value.includes("\uFFFD")) return undefined;
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

/**
 * Patch sections are matched by their exact header line. Git quotes names containing `"`, and a
 * name containing " b/" could make `diff --git a/X b/Y` read as another pair, so such names are
 * omitted from git_diff instead.
 */
function patchable(relative: string) {
  return !relative.includes('"') && !relative.includes(" b/");
}

/** Lines that start one file's section in `git diff` / `git diff-files` patch output. */
const SECTION_HEADER = /^(?:diff --git |diff --cc |diff --combined |\* Unmerged path )/;

/** Every header Git may print for one listed file. */
function patchHeaders(file: GitDiffFile) {
  const headers = [`diff --git a/${file.previous_path ?? file.path} b/${file.path}`];
  if (file.status === "U")
    headers.push(
      `diff --cc ${file.path}`,
      `diff --combined ${file.path}`,
      `* Unmerged path ${file.path}`,
    );
  return headers;
}

/**
 * Splits patch output into per-file sections at complete header lines. A literal pathspec also
 * matches everything below a directory of the same name (a file replaced by a directory, or the
 * reverse), so callers keep a section only when its header names an allowed file exactly. Text
 * before the first header belongs to no section and is dropped.
 */
export function patchSections(text: string) {
  const sections: { header: string; start: number; end: number }[] = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) break;
    const line = text.slice(offset, newline);
    if (SECTION_HEADER.test(line)) {
      const previous = sections.at(-1);
      if (previous) previous.end = offset;
      sections.push({ header: line, start: offset, end: text.length });
    }
    offset = newline + 1;
  }
  return sections;
}

/** A BEGIN or END line of a PEM private key; hunks may show key lines without either marker. */
const PRIVATE_KEY_MARKER = "PRIVATE KEY-----";
const WITHHELD_HUNKS = "[PRIVATE KEY REDACTED]\n";

/** Keeps a section's headers and replaces all of its hunks with one redaction line. */
function withholdHunks(section: string) {
  const hunk = section.search(/^@@/m);
  return hunk === -1 ? section : section.slice(0, hunk) + WITHHELD_HUNKS;
}

/**
 * Paths whose old or new content contains a private-key marker anywhere, searched with
 * `git grep` in each compared source (`HEAD`, `--cached` for the index, none for the working
 * tree). A diff fragment can show key lines between markers that fall outside the hunk.
 */
async function privateKeyPaths(
  repository: GitRepository,
  sources: readonly (readonly string[])[],
  pathspecs: readonly string[],
): Promise<Set<string> | GitOutcome> {
  const found = new Set<string>();
  for (const source of sources) {
    const outcome = await repository.run([
      "grep",
      "--no-recurse-submodules",
      "--no-textconv",
      "-l",
      "-z",
      "-F",
      "-e",
      PRIVATE_KEY_MARKER,
      ...source,
      "--",
      ...pathspecs,
    ]);
    if (outcome.kind === "failed" && outcome.exitCode === 1) continue;
    if (outcome.kind !== "ok") return outcome;
    for (const name of records(outcome.stdout))
      found.add(source[0] === "HEAD" ? name.replace(/^HEAD:/, "") : name);
  }
  return found;
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
      const previous = file.previous === undefined ? undefined : publicPath(file.previous);
      if (
        file.link ||
        !current ||
        !patchable(current) ||
        (file.previous !== undefined && (!previous || !patchable(previous))) ||
        !DIFF_STATUSES.has(file.status)
      ) {
        omitted++;
        continue;
      }
      allowed.push({
        path: current,
        ...(previous !== undefined ? { previous_path: previous } : {}),
        status: file.status as GitDiffFile["status"],
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
        pathspecs: [literal(current), ...(previous !== undefined ? [literal(previous)] : [])],
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
    const headers = new Map<string, number>();
    candidates.forEach((file, position) => {
      for (const header of patchHeaders(file)) headers.set(header, position);
    });
    // Old and new content of each side: index and working tree, or HEAD (once born) and index.
    let sources: string[][] = [["--cached"], []];
    if (input.staged && candidates.length > 0) {
      const head = await repository.run(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      if (head.kind !== "ok" && !(head.kind === "failed" && head.exitCode === 1))
        return { ...base, ...unavailable(outcomeReason(head, "failed")) };
      sources = head.kind === "ok" ? [["HEAD"], ["--cached"]] : [["--cached"]];
    }
    let truncated = allowed.length > candidates.length;
    const emitted = new Set<number>();
    const kept: string[] = [];
    let withheld = false;
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
      const [patch, keyed] = await Promise.all([
        repository.run([...patchArgs, ...pathspecs], { maxBuffer: GIT_DIFF_BYTES - bytes }),
        privateKeyPaths(repository, sources, pathspecs),
      ]);
      if (patch.kind !== "ok" && patch.kind !== "overflow")
        return { ...base, ...unavailable(outcomeReason(patch, "failed")) };
      if (!(keyed instanceof Set))
        return { ...base, ...unavailable(outcomeReason(keyed, "failed")) };
      bytes += patch.stdout.length;
      const output = new TextDecoder("utf-8").decode(patch.stdout);
      for (const section of patchSections(output)) {
        const position = headers.get(section.header);
        const file = position === undefined ? undefined : candidates[position];
        if (position === undefined || !file || emitted.has(position)) continue;
        emitted.add(position);
        const body = output.slice(section.start, section.end);
        const keyBearing =
          keyed.has(file.path) ||
          (file.previous_path !== undefined && keyed.has(file.previous_path));
        const shown = keyBearing ? withholdHunks(body) : body;
        if (shown !== body) withheld = true;
        kept.push(shown);
      }
      if (patch.kind === "overflow") {
        truncated = true;
        break;
      }
    }
    const text = kept.join("");
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
      redacted: withheld || safe !== text,
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
