import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type GitDiff,
  GitDiffSchema,
  type GitLog,
  GitLogSchema,
  type GitStatus,
  GitStatusSchema,
  LIMITS,
} from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { gitEnvironment, openGitRepository, pageText, parseDiffListing, runGit } from "./git.ts";
import { readHandoffWorkingTree } from "./handoff-working-tree.ts";
import { ToolService } from "./tools.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let service: ToolService;
beforeEach(async () => {
  f = await fixture();
  service = new ToolService(f.registry, true);
});
afterEach(async () => {
  await service.close();
  await f.dispose();
});

/** Synthetic repositories only; the helper never runs repository hooks. */
async function git(...args: string[]) {
  const command = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=NUL",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Synthetic fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-C",
      f.root,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const [code, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()]);
  expect(code).toBe(0);
  return stdout.trim();
}

async function initRepository() {
  await git("init", "--initial-branch=main", "--template=");
}

async function call(name: "git_status" | "git_diff" | "git_log", args: object = {}) {
  const result = await service.call(name, { workspace_id: f.workspace.id, ...args }, "mcp");
  expect(JSON.stringify(result)).not.toContain(f.root);
  if (result.isError)
    throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "");
  return result.structuredContent;
}
const status = async () => GitStatusSchema.parse(await call("git_status")) as GitStatus;
const diff = async (args: object = {}) =>
  GitDiffSchema.parse(await call("git_diff", args)) as GitDiff;
const log = async (args: object = {}) => GitLogSchema.parse(await call("git_log", args)) as GitLog;

async function errorCode(name: "git_status" | "git_diff" | "git_log", args: object) {
  const result = await service.call(name, { workspace_id: f.workspace.id, ...args }, "mcp");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.root);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
  return (JSON.parse(text) as { code: string }).code;
}

describe("read-only Git status", () => {
  test("reports staged, unstaged, untracked and renamed entries while omitting private paths", async () => {
    await writeFile(path.join(f.root, ".env"), "TOKEN=original\n");
    await mkdir(path.join(f.root, "docs"));
    await writeFile(path.join(f.root, "docs", "old.md"), "# Guide\n");
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await writeFile(path.join(f.root, "README.md"), "# Fixture\nchanged\n");
    await writeFile(path.join(f.root, "src", "new.ts"), "export const added = true;\n");
    await writeFile(path.join(f.root, "src", "main.ts"), "export const message = 'staged';\n");
    await git("add", "--", "src/new.ts", "src/main.ts");
    await writeFile(path.join(f.root, "src", "main.ts"), "export const message = 'both';\n");
    await git("mv", "--", "docs/old.md", "docs/guide.md");
    await writeFile(path.join(f.root, "notes.txt"), "untracked\n");
    await writeFile(path.join(f.root, ".env"), "TOKEN=changed-private\n");
    await mkdir(path.join(f.root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(f.root, "node_modules", "pkg", "index.js"), "private\n");
    await mkdir(path.join(f.root, "dist"));
    await writeFile(path.join(f.root, "dist", "out.js"), "private\n");

    const result = await status();
    const sha = await git("rev-parse", "HEAD");
    expect(result).toMatchObject({
      state: "available",
      reason: null,
      branch: "main",
      detached: false,
      upstream: null,
      truncated: false,
      omitted_private: 3,
      head: { sha, subject: "Synthetic baseline" },
    });
    expect(sha.startsWith(result.head?.short_sha ?? "-")).toBe(true);
    const byPath = Object.fromEntries(result.entries.map((entry) => [entry.path, entry]));
    expect(byPath["README.md"]).toEqual({
      path: "README.md",
      index_status: ".",
      worktree_status: "M",
      kind: "unstaged",
    });
    expect(byPath["src/new.ts"]).toMatchObject({ index_status: "A", kind: "staged" });
    expect(byPath["src/main.ts"]).toMatchObject({
      index_status: "M",
      worktree_status: "M",
      kind: "staged",
    });
    expect(byPath["docs/guide.md"]).toEqual({
      path: "docs/guide.md",
      previous_path: "docs/old.md",
      index_status: "R",
      worktree_status: ".",
      kind: "staged",
    });
    expect(byPath["notes.txt"]).toMatchObject({ index_status: "?", kind: "untracked" });
    expect(result.entries).toHaveLength(5);
    const serialized = JSON.stringify(result);
    for (const hidden of [".env", "changed-private", "node_modules", "dist"])
      expect(serialized).not.toContain(hidden);
  });

  test("reports upstream divergence, detached HEAD and an unborn branch without inventing commits", async () => {
    await initRepository();
    const unborn = await status();
    expect(unborn).toMatchObject({ state: "available", branch: "main", head: null });
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const remote = path.join(f.directory, "remote.git");
    await git("init", "--bare", "--template=", remote);
    await git("remote", "add", "origin", remote);
    await git("push", "--quiet", "-u", "origin", "main");
    await writeFile(path.join(f.root, "README.md"), "# Ahead\n");
    await git("commit", "-am", "Local only");
    expect((await status()).upstream).toEqual({ name: "origin/main", ahead: 1, behind: 0 });
    await git("checkout", "--quiet", "--detach");
    const detached = await status();
    expect(detached).toMatchObject({ branch: null, detached: true, upstream: null });
    expect(detached.head?.subject).toBe("Local only");
  });

  test("non-repositories and nested or relocated work trees are unavailable, not errors", async () => {
    for (const name of ["git_status", "git_diff", "git_log"] as const) {
      const result = (await call(name)) as { state: string; reason: string };
      expect(result).toMatchObject({ state: "unavailable", reason: "not_repository" });
    }
    await initRepository();
    const nested = await f.registry.add(path.join(f.root, "src"), "子資料夾");
    const nestedResult = await service.call("git_status", { workspace_id: nested.id }, "mcp");
    expect(nestedResult.structuredContent).toMatchObject({
      state: "unavailable",
      reason: "not_repository",
      entries: [],
    });
    expect(JSON.stringify(nestedResult)).not.toContain(f.root);
    const elsewhere = path.join(f.directory, "elsewhere");
    await mkdir(elsewhere);
    await git("config", "core.worktree", elsewhere);
    expect(await status()).toMatchObject({ state: "unavailable", reason: "root_mismatch" });
    expect((await readHandoffWorkingTree(f.root)).state).toBe("unavailable");
  });
});

describe("read-only Git diff", () => {
  test("redacts secrets, omits private files and treats listed names as literal pathspecs", async () => {
    await writeFile(path.join(f.root, ".env"), "API=1\n");
    await writeFile(path.join(f.root, "[.]env"), "visible=1\n");
    await writeFile(path.join(f.root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const openai = `sk-proj-${"A".repeat(32)}`;
    const github = `ghp_${"B".repeat(36)}`;
    await writeFile(path.join(f.root, "README.md"), `# Fixture\nkey=${openai}\ntoken=${github}\n`);
    await writeFile(path.join(f.root, ".env"), "API=2\nSECRET_PRIVATE_VALUE\n");
    await writeFile(path.join(f.root, "[.]env"), "visible=2\n");
    await writeFile(path.join(f.root, "image.bin"), Buffer.from([0, 9, 9, 9]));
    await writeFile(path.join(f.root, "src", "main.ts"), "export const message = 'staged';\n");
    await git("add", "--", "src/main.ts");

    const worktree = await diff();
    expect(worktree).toMatchObject({
      state: "available",
      staged: false,
      omitted_private: 1,
      has_more: false,
      next_cursor: null,
      truncated: false,
      redacted: true,
    });
    expect(worktree.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "[.]env",
      "image.bin",
    ]);
    expect(worktree.files.find((file) => file.path === "image.bin")).toMatchObject({
      binary: true,
      additions: 0,
      deletions: 0,
    });
    expect(worktree.files.find((file) => file.path === "README.md")).toMatchObject({
      status: "M",
      additions: 2,
      deletions: 2,
      binary: false,
    });
    expect(worktree.diff).toContain("[OPENAI KEY REDACTED]");
    expect(worktree.diff).toContain("[GITHUB TOKEN REDACTED]");
    expect(worktree.diff).toContain("+visible=2");
    for (const hidden of [openai, github, "SECRET_PRIVATE_VALUE", "API=2", "a/.env"])
      expect(JSON.stringify(worktree)).not.toContain(hidden);
    expect(worktree.diff).not.toContain("src/main.ts");

    const staged = await diff({ staged: true });
    expect(staged.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(staged.diff).toContain("+export const message = 'staged';");

    const scoped = await diff({ path: "[.]env", context_lines: 0 });
    expect(scoped.files.map((file) => file.path)).toEqual(["[.]env"]);
    expect(scoped.omitted_private).toBe(0);
    expect(scoped.diff).not.toContain("SECRET_PRIVATE_VALUE");
  });

  test("lists renames with both literal paths and hides renames from private names", async () => {
    await writeFile(path.join(f.root, ".env.local"), "PRIVATE_BODY\n");
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await git("mv", "--", "README.md", "GUIDE.md");
    await git("mv", "--", ".env.local", "public.txt");
    const staged = await diff({ staged: true });
    expect(staged.files).toEqual([
      {
        path: "GUIDE.md",
        previous_path: "README.md",
        status: "R",
        additions: 0,
        deletions: 0,
        binary: false,
      },
    ]);
    expect(staged.omitted_private).toBe(1);
    expect(staged.diff).toContain("rename from README.md");
    expect(JSON.stringify(staged)).not.toContain("PRIVATE_BODY");
    expect(JSON.stringify(staged)).not.toContain(".env.local");
  });

  test("pages long diffs within the response limit and rejects stale or forged cursors", async () => {
    const lines = (label: string) =>
      Array.from({ length: 2500 }, (_, index) => `line ${index} ${label} ${"x".repeat(20)}`).join(
        "\n",
      );
    await writeFile(path.join(f.root, "big.txt"), `${lines("before")}\n`);
    await writeFile(path.join(f.root, "long.txt"), `${"a".repeat(70_000)}\n`);
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await writeFile(path.join(f.root, "big.txt"), `${lines("after")}\n`);
    await writeFile(path.join(f.root, "long.txt"), `${"b".repeat(70_000)}\n`);

    const pages: GitDiff[] = [];
    let cursor: string | undefined;
    do {
      const page = await diff(cursor ? { cursor } : {});
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LIMITS.responseBytes);
      expect(page.has_more).toBe(page.next_cursor !== null);
      pages.push(page);
      cursor = page.next_cursor ?? undefined;
    } while (cursor && pages.length < 50);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.at(-1)?.has_more).toBe(false);
    const text = pages.map((page) => page.diff).join("");
    expect(text).toContain(`-${"a".repeat(70_000)}\n+${"b".repeat(70_000)}\n`);
    for (const index of [0, 1234, 2499]) {
      expect(text).toContain(`-line ${index} before`);
      expect(text).toContain(`+line ${index} after`);
    }
    expect(text.match(/^diff --git /gm)).toHaveLength(2);

    const stale = pages[1]?.next_cursor ?? "";
    const [, digest] = stale.split(".");
    expect(await errorCode("git_diff", { cursor: `99999999.${digest}` })).toBe("INVALID_CURSOR");
    await writeFile(path.join(f.root, "big.txt"), "rewritten\n");
    expect(await errorCode("git_diff", { cursor: stale })).toBe("GIT_DIFF_CHANGED");
    expect(await errorCode("git_diff", { cursor: "not-a-cursor" })).toBe("VALIDATION");
  });

  test("repository-configured programs never run: textconv, external diff, filters, fsmonitor, hooks and signature checks", async () => {
    await writeFile(path.join(f.root, "a.txt"), "one\ntwo\n");
    await writeFile(path.join(f.root, ".gitattributes"), "*.txt diff=evil filter=evil\n");
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    // A commit carrying a signature makes log.showSignature invoke gpg.program.
    const tree = await git("rev-parse", "HEAD^{tree}");
    const parent = await git("rev-parse", "HEAD");
    const commitFile = path.join(f.directory, "signed-commit.txt");
    await writeFile(
      commitFile,
      `tree ${tree}\nparent ${parent}\nauthor Synthetic fixture <fixture@example.invalid> 1700000000 +0800\ncommitter Synthetic fixture <fixture@example.invalid> 1700000000 +0800\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n synthetic\n -----END PGP SIGNATURE-----\n\nSigned synthetic commit\n`,
    );
    const signed = await git("hash-object", "-t", "commit", "-w", commitFile);
    await git("update-ref", "refs/heads/main", signed);
    await writeFile(path.join(f.root, "a.txt"), "one\nTWO\n");
    await writeFile(path.join(f.root, "README.md"), "# Changed\n");
    const old = new Date("2001-01-01T00:00:00Z");
    await utimes(path.join(f.root, "a.txt"), old, old);
    await utimes(path.join(f.root, "README.md"), old, old);
    const fakeGpg = path.join(f.directory, "fake-gpg.sh");
    await writeFile(fakeGpg, "#!/bin/sh\necho pwned >> gpg-ran\nexit 1\n");
    await chmod(fakeGpg, 0o755);
    await mkdir(path.join(f.root, ".git", "hooks"), { recursive: true });
    const hook = path.join(f.root, ".git", "hooks", "post-index-change");
    await writeFile(hook, "#!/bin/sh\necho pwned >> hook-ran\n");
    await chmod(hook, 0o755);
    for (const [key, value] of [
      ["diff.evil.textconv", "echo pwned >> textconv-ran; cat"],
      ["diff.evil.command", "echo pwned >> command-ran; true"],
      ["diff.external", "echo pwned >> external-ran; true"],
      ["filter.evil.clean", "echo pwned >> clean-ran; cat"],
      ["filter.evil.smudge", "echo pwned >> smudge-ran; cat"],
      ["filter.evil.required", "true"],
      ["core.fsmonitor", "echo pwned >> fsmonitor-ran; false"],
      ["log.showSignature", "true"],
      ["gpg.program", fakeGpg],
    ] as const)
      await git("config", key, value);
    const markers = [
      "textconv-ran",
      "command-ran",
      "external-ran",
      "clean-ran",
      "smudge-ran",
      "fsmonitor-ran",
      "hook-ran",
      "gpg-ran",
    ];

    const current = await status();
    expect(current.state).toBe("available");
    expect(current.head?.subject).toBe("Signed synthetic commit");
    expect(current.entries.map((entry) => entry.path).sort()).toEqual(["README.md", "a.txt"]);
    const worktree = await diff();
    expect(worktree.diff).toContain("-two\n+TWO");
    await diff({ staged: true });
    expect((await log()).commits[0]?.subject).toBe("Signed synthetic commit");
    expect((await readHandoffWorkingTree(f.root)).state).toBe("available");
    for (const marker of markers) expect(existsSync(path.join(f.root, marker))).toBe(false);

    if (process.platform !== "win32") {
      // Positive control: the same repository does run these programs through plain Git.
      const plain = async (...args: string[]) => {
        const child = Bun.spawn(["git", ...args], {
          cwd: f.root,
          stdout: "ignore",
          stderr: "ignore",
        });
        await child.exited;
      };
      await plain("status", "--porcelain");
      await plain("diff");
      await plain("log", "-1", "--format=%s");
      for (const marker of ["clean-ran", "fsmonitor-ran", "external-ran", "gpg-ran"])
        expect(existsSync(path.join(f.root, marker))).toBe(true);
    }
  });

  test("reads never rewrite the index, even for stat-dirty files", async () => {
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const old = new Date("2001-01-01T00:00:00Z");
    await utimes(path.join(f.root, "README.md"), old, old);
    await writeFile(path.join(f.root, "src", "main.ts"), "export const message = 'changed';\n");
    const index = path.join(f.root, ".git", "index");
    const before = await readFile(index);
    const changed = await diff();
    expect(changed.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    await diff({ staged: true });
    await status();
    await log();
    expect((await readFile(index)).equals(before)).toBe(true);
  });

  test("unusual filter driver names fail closed instead of running Git", async () => {
    await initRepository();
    await git("config", "filter.bad=name.clean", "cat");
    expect(await status()).toMatchObject({ state: "unavailable", reason: "unsupported_config" });
  });
});

describe("read-only Git log", () => {
  test("bounds history, filters by literal path and never returns email addresses", async () => {
    await initRepository();
    expect(await log()).toMatchObject({ state: "available", commits: [], has_more: false });
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await writeFile(path.join(f.root, "README.md"), "# Second\n");
    await git("commit", "-am", "Second change");
    await writeFile(path.join(f.root, "src", "main.ts"), "export const third = true;\n");
    await git("commit", "-am", `Third change ${"sk-proj-"}${"C".repeat(30)}`);

    const recent = await log({ limit: 2 });
    expect(recent.has_more).toBe(true);
    expect(recent.commits.map((commit) => commit.subject)).toEqual([
      "Third change [OPENAI KEY REDACTED]",
      "Second change",
    ]);
    const [first] = recent.commits;
    expect(first?.sha).toBe(await git("rev-parse", "HEAD"));
    expect(first?.sha.startsWith(first?.short_sha ?? "-")).toBe(true);
    expect(first?.author_name).toBe("Synthetic fixture");
    expect(Number.isNaN(Date.parse(first?.authored_at ?? ""))).toBe(false);
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "author_name",
      "authored_at",
      "sha",
      "short_sha",
      "subject",
    ]);
    const serialized = JSON.stringify(await log({ limit: 50 }));
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("example.invalid");

    const scoped = await log({ path: "src/main.ts" });
    expect(scoped.path).toBe("src/main.ts");
    expect(scoped.commits.map((commit) => commit.subject)).toEqual([
      "Third change [OPENAI KEY REDACTED]",
      "Synthetic baseline",
    ]);
    expect(scoped.has_more).toBe(false);
  });
});

describe("Git tool boundaries", () => {
  test("model paths use file_read validation and inputs are strictly bounded", async () => {
    await initRepository();
    expect(await errorCode("git_diff", { path: "../outside.txt" })).toBe("INVALID_PATH");
    expect(await errorCode("git_diff", { path: "/etc/passwd" })).toBe("INVALID_PATH");
    expect(await errorCode("git_diff", { path: "src\\main.ts" })).toBe("INVALID_PATH");
    expect(await errorCode("git_diff", { path: ".env" })).toBe("PRIVATE_PATH");
    expect(await errorCode("git_log", { path: "node_modules/pkg" })).toBe("PRIVATE_PATH");
    expect(await errorCode("git_log", { path: ".git/config" })).toBe("PRIVATE_PATH");
    expect(await errorCode("git_log", { limit: 51 })).toBe("VALIDATION");
    expect(await errorCode("git_diff", { context_lines: 11 })).toBe("VALIDATION");
    expect(await errorCode("git_status", { path: "README.md" })).toBe("VALIDATION");
    const unknown = await service.call("git_status", { workspace_id: crypto.randomUUID() }, "mcp");
    expect(JSON.stringify(unknown)).toContain("WORKSPACE_NOT_FOUND");
  });

  test("the workbench activity shows concise titles without diff text", async () => {
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await writeFile(path.join(f.root, "README.md"), "# Fixture\nACTIVITY_DIFF_TEXT\n");
    await status();
    await diff({ path: "README.md" });
    await log();
    const entries = service.activity.list();
    expect(entries.map((entry) => [entry.tool, entry.title, entry.state])).toEqual([
      ["git_log", "查看 Git 紀錄", "completed"],
      ["git_diff", "查看 Git 差異", "completed"],
      ["git_status", "查看 Git 狀態", "completed"],
    ]);
    expect(entries[1]?.path).toBe("README.md");
    expect(JSON.stringify(entries)).not.toContain("ACTIVITY_DIFF_TEXT");
    const retained = entries[1]?.resultId ? service.activityResult(entries[1].resultId) : undefined;
    expect(retained?.kind).toBe("git_diff");
  });

  test("the runner never inherits repository-selecting Git variables", () => {
    const env = gitEnvironment("/ceiling", {
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "C.UTF-8",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
      GIT_EXTERNAL_DIFF: "evil",
      GIT_SSH_COMMAND: "evil",
      OPENAI_API_KEY: "secret",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "C.UTF-8",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_PAGER: "cat",
      GIT_CEILING_DIRECTORIES: "/ceiling",
    });
  });

  test("the runner bounds output and the opener requires the exact repository root", async () => {
    await initRepository();
    const cut = await runGit(f.root, ["rev-parse", "--show-toplevel"], { maxBuffer: 4 });
    expect(cut).toMatchObject({ kind: "overflow" });
    expect(cut.kind === "overflow" ? cut.stdout.length : -1).toBe(4);
    expect((await openGitRepository(f.root)).state).toBe("available");
    expect(await openGitRepository(path.join(f.root, "src"))).toEqual({
      state: "unavailable",
      reason: "not_repository",
    });
    expect(await runGit(f.root, ["rev-parse", "--verify", "-q", "HEAD"])).toEqual({
      kind: "failed",
      exitCode: 1,
    });
  });
});

describe("Git output parsing", () => {
  test("pages by encoded bytes without splitting surrogate pairs", () => {
    // A newline is two bytes once JSON-encoded.
    expect(pageText("a\nbb\nccc\n", 0, 6)).toEqual({ text: "a\n", end: 2 });
    expect(pageText("a\nbb\nccc\n", 0, 7)).toEqual({ text: "a\nbb\n", end: 5 });
    expect(pageText("a\nbb\nccc\n", 5, 100)).toEqual({ text: "ccc\n", end: 9 });
    const long = pageText("x".repeat(100), 0, 10);
    expect(long).toEqual({ text: "x".repeat(10), end: 10 });
    const emoji = pageText("😀😀😀", 0, 9);
    expect(emoji.text).toBe("😀😀");
    expect(pageText("\u0001\u0001", 0, 6).text).toBe("\u0001");
  });

  test("diff listings with renames, binary files and links parse or reject as a whole", () => {
    const listing = Buffer.from(
      [
        ":100644 100644 aaaaaaa bbbbbbb M",
        "a b.txt",
        ":100644 100644 aaaaaaa bbbbbbb R100",
        "old.md",
        "new.md",
        ":100644 120000 aaaaaaa bbbbbbb T",
        "link",
        "1\t2\ta b.txt",
        "0\t0\t",
        "old.md",
        "new.md",
        "-\t-\tlink",
        ":100644 100644 aaaaaaa 0000000 M",
        "stat-only.txt",
        "",
      ].join("\0"),
    );
    expect(parseDiffListing(listing)).toEqual([
      { status: "M", path: "a b.txt", link: false, additions: 1, deletions: 2, binary: false },
      {
        status: "R",
        path: "new.md",
        previous: "old.md",
        link: false,
        additions: 0,
        deletions: 0,
        binary: false,
      },
      { status: "T", path: "link", link: true, additions: 0, deletions: 0, binary: true },
    ]);
    expect(parseDiffListing(Buffer.from("garbage\0"))).toBeUndefined();
    expect(parseDiffListing(Buffer.from(":100644 100644 a b R100\0old.md\0"))).toBeUndefined();
    expect(parseDiffListing(Buffer.from(":100644 100644 a b M\0unterminated"))).toBeUndefined();
  });
});
