import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, constants, existsSync, openSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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
import {
  gitEnvironment,
  openGitRepository,
  pageText,
  parseDiffListing,
  patchSections,
  runGit,
} from "./git.ts";
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
async function gitAt(cwd: string, ...args: string[]) {
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
      cwd,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const [code, stdout] = await Promise.all([command.exited, new Response(command.stdout).text()]);
  expect(code).toBe(0);
  return stdout.trim();
}
const git = (...args: string[]) => gitAt(f.root, ...args);

/** A sibling repository the mounted workspace must never expose. */
async function outsideRepository() {
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  await gitAt(outside, "init", "--initial-branch=main", "--template=");
  await writeFile(path.join(outside, "payroll.csv"), "alice,250000\nbob,180000\n");
  await gitAt(outside, "add", "-A");
  await gitAt(outside, "commit", "-m", "outside history: Q3 payroll");
  return outside;
}

/** Path values written into Git files or config use forward slashes on every platform. */
const portable = (value: string) => value.replaceAll("\\", "/");

async function expectUnavailable(reason: string, id = f.workspace.id) {
  for (const name of ["git_status", "git_diff", "git_log"] as const) {
    const result = await service.call(name, { workspace_id: id }, "mcp");
    expect(result.structuredContent).toMatchObject({ state: "unavailable", reason });
    const serialized = JSON.stringify(result);
    for (const hidden of ["payroll", "alice", "250000", "Q3", f.directory])
      expect(serialized).not.toContain(hidden);
  }
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

async function errorCode(name: "git_status" | "git_diff" | "git_log" | "file_read", args: object) {
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

describe("Git diff sections and private keys", () => {
  test("a file replaced by a directory, or the reverse, never leaks a private child through its pathspec", async () => {
    const secret = "DB_PASSWORD=correct-horse-battery-staple";
    await writeFile(path.join(f.root, "cfg"), "placeholder\n");
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    await git("rm", "--quiet", "--cached", "cfg");
    await rm(path.join(f.root, "cfg"));
    await mkdir(path.join(f.root, "cfg"));
    await writeFile(path.join(f.root, "cfg", ".env"), `${secret}\n`);
    await writeFile(path.join(f.root, "cfg", "public.txt"), "visible\n");
    await git("add", "-f", "--", "cfg/.env", "cfg/public.txt");
    // Positive control: plain Git with the same literal pathspec prints the private child.
    expect(await git("diff", "--cached", "--", ":(literal)cfg")).toContain(secret);
    for (const args of [{ staged: true }, { staged: true, path: "cfg" }]) {
      const result = await diff(args);
      expect(result.files.map((file) => [file.path, file.status])).toEqual([
        ["cfg", "D"],
        ["cfg/public.txt", "A"],
      ]);
      expect(result.omitted_private).toBe(1);
      expect(result.diff).toContain("-placeholder");
      expect(result.diff.match(/^diff --git a\/cfg\/public\.txt /gm)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("correct-horse");
      expect(JSON.stringify(result)).not.toContain("cfg/.env");
    }
    expect(await errorCode("file_read", { path: "cfg/.env" })).toBe("PRIVATE_PATH");

    // The reverse: a committed private file under cfg/ becomes the file cfg in the index.
    await git("commit", "-m", "Directory with a private file");
    await git("rm", "-r", "--quiet", "--cached", "cfg");
    await rm(path.join(f.root, "cfg"), { recursive: true });
    await writeFile(path.join(f.root, "cfg"), "public again\n");
    await git("add", "--", "cfg");
    const reverse = await diff({ staged: true });
    expect(reverse.files.map((file) => [file.path, file.status]).sort()).toEqual([
      ["cfg", "A"],
      ["cfg/public.txt", "D"],
    ]);
    expect(reverse.omitted_private).toBe(1);
    expect(reverse.diff).toContain("+public again");
    expect(JSON.stringify(reverse)).not.toContain("correct-horse");
  });

  test("hunks of a file whose old or new content holds a private key are withheld", async () => {
    const pem = (seed: string) =>
      [
        "tls:",
        "  key: |",
        "    -----BEGIN PRIVATE KEY-----",
        ...Array.from({ length: 6 }, (_, line) => `    ${seed.repeat(8)}${line}AAAABBBBCCCCDDDD`),
        "    -----END PRIVATE KEY-----",
        "",
      ].join("\n");
    await mkdir(path.join(f.root, "deploy"));
    await writeFile(path.join(f.root, "deploy", "tls.yaml"), pem("OLDKEY"));
    await initRepository();
    // Before the first commit only the index side exists.
    await git("add", "-A");
    const initial = await diff({ staged: true });
    expect(initial.redacted).toBe(true);
    expect(initial.diff).toContain("[PRIVATE KEY REDACTED]");
    expect(initial.diff).not.toContain("OLDKEY");
    await git("commit", "-m", "Synthetic baseline");
    await writeFile(path.join(f.root, "deploy", "tls.yaml"), pem("NEWKEY"));
    await writeFile(path.join(f.root, "README.md"), "# Fixture\nchanged\n");
    const worktree = await diff({ context_lines: 0 });
    expect(worktree.redacted).toBe(true);
    expect(worktree.files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "deploy/tls.yaml",
    ]);
    expect(worktree.diff).toContain("+++ b/deploy/tls.yaml\n[PRIVATE KEY REDACTED]\n");
    expect(worktree.diff).toContain("+changed");
    for (const hidden of ["OLDKEY", "NEWKEY", "AAAABBBB"])
      expect(worktree.diff).not.toContain(hidden);
    await git("add", "--", "deploy/tls.yaml");
    const staged = await diff({ staged: true, context_lines: 0 });
    expect(staged.redacted).toBe(true);
    for (const hidden of ["OLDKEY", "NEWKEY"]) expect(staged.diff).not.toContain(hidden);
    // Removing the key from the new content still withholds the old key lines.
    await writeFile(path.join(f.root, "deploy", "tls.yaml"), "tls: {}\n");
    const removed = await diff({ path: "deploy/tls.yaml" });
    expect(removed.diff).not.toContain("NEWKEY");
    expect(removed.redacted).toBe(true);
  });

  test("names over 1024 characters or that cannot be matched safely are omitted instead of failing", async () => {
    await initRepository();
    await git("config", "core.longpaths", "true");
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const blob = await git("hash-object", "-w", "README.md");
    const long = [
      ...Array.from({ length: 5 }, (_, index) => `${index}${"d".repeat(220)}`),
      "file.txt",
    ];
    expect(long.join("/").length).toBeGreaterThan(1024);
    const names = [long.join("/"), "x b/y.md"];
    // Windows file names cannot contain a double quote.
    if (process.platform !== "win32") names.push('docs/say "hi".md');
    for (const name of names)
      await git("update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
    const current = await status();
    expect(current.state).toBe("available");
    expect(current.omitted_private).toBe(1);
    expect(current.entries.map((entry) => entry.path).sort()).toEqual(names.slice(1).sort());
    const staged = await diff({ staged: true });
    expect(staged).toMatchObject({ state: "available", files: [], diff: "" });
    expect(staged.omitted_private).toBe(names.length);
  });
});

describe("Git repository boundaries", () => {
  test("a .git file, commondir file or .git link that selects another repository is refused", async () => {
    const outside = await outsideRepository();
    await writeFile(path.join(f.root, ".git"), "gitdir: ../outside/.git\n");
    // Positive control: plain Git follows the gitfile into the other repository.
    expect(await git("log", "-1", "--format=%s")).toBe("outside history: Q3 payroll");
    await expectUnavailable("root_mismatch");
    expect((await readHandoffWorkingTree(f.root)).state).toBe("unavailable");
    await rm(path.join(f.root, ".git"));

    await initRepository();
    await writeFile(path.join(f.root, ".git", "commondir"), portable(path.join(outside, ".git")));
    expect(await git("log", "-1", "--format=%s")).toBe("outside history: Q3 payroll");
    await expectUnavailable("root_mismatch");
    await rm(path.join(f.root, ".git", "commondir"));
    expect((await status()).state).toBe("available");

    if (process.platform !== "win32") {
      await rename(path.join(f.root, ".git"), path.join(f.directory, "moved.git"));
      await symlink(path.join(outside, ".git"), path.join(f.root, ".git"));
      await expectUnavailable("root_mismatch");
    }
  });

  test("alternates and links inside the Git directory are refused", async () => {
    const outside = await outsideRepository();
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const borrowed = await gitAt(outside, "rev-parse", "HEAD");
    const alternates = path.join(f.root, ".git", "objects", "info", "alternates");
    await mkdir(path.dirname(alternates), { recursive: true });
    await writeFile(alternates, `${portable(path.join(outside, ".git", "objects"))}\n`);
    await git("update-ref", "refs/heads/main", borrowed);
    expect(await git("log", "-1", "--format=%s")).toBe("outside history: Q3 payroll");
    await expectUnavailable("unsupported_config");
    await rm(alternates);

    if (process.platform !== "win32") {
      await initRepository();
      await rm(path.join(f.root, ".git", "refs", "heads"), { recursive: true });
      await symlink(
        path.join(outside, ".git", "refs", "heads"),
        path.join(f.root, ".git", "refs", "heads"),
      );
      await expectUnavailable("unsupported_config");
    }
  });

  test("linked worktrees and submodules of this checkout stay available; a borrowed gitfile does not", async () => {
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const worktree = path.join(f.directory, "feature-tree");
    await git("worktree", "add", "--quiet", "-b", "feature", worktree);
    const linked = await f.registry.add(worktree, "連結工作樹");
    const linkedStatus = await service.call("git_status", { workspace_id: linked.id }, "mcp");
    expect(linkedStatus.structuredContent).toMatchObject({
      state: "available",
      branch: "feature",
      head: { subject: "Synthetic baseline" },
    });
    expect((await readHandoffWorkingTree(worktree)).state).toBe("available");

    // The same .git file copied elsewhere does not point back at the copy.
    const copy = path.join(f.directory, "borrowed");
    await mkdir(copy);
    await writeFile(path.join(copy, ".git"), await readFile(path.join(worktree, ".git")));
    const borrowed = await f.registry.add(copy, "借用");
    await expectUnavailable("root_mismatch", borrowed.id);

    const library = path.join(f.directory, "library");
    await mkdir(library);
    await gitAt(library, "init", "--initial-branch=main", "--template=");
    await writeFile(path.join(library, "lib.txt"), "library\n");
    await gitAt(library, "add", "-A");
    await gitAt(library, "commit", "-m", "Library baseline");
    await git(
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      portable(library),
      "vendor-lib",
    );
    const submodule = await f.registry.add(path.join(f.root, "vendor-lib"), "子模組");
    const submoduleLog = await service.call("git_log", { workspace_id: submodule.id }, "mcp");
    expect(submoduleLog.structuredContent).toMatchObject({ state: "available" });
    expect(
      (submoduleLog.structuredContent as GitLog).commits.map((commit) => commit.subject),
    ).toEqual(["Library baseline"]);
  });

  test("partial clones and promisor remotes are refused, and transports stay blocked without GIT_NO_LAZY_FETCH", async () => {
    await writeFile(path.join(f.root, "a.txt"), "original\n");
    await initRepository();
    await git("add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    const marker = path.join(f.directory, "lazy-fetch-ran");
    for (const [key, value] of [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.url", portable(f.root)],
      ["remote.origin.promisor", "true"],
      ["remote.origin.partialclonefilter", "blob:none"],
      ["protocol.file.allow", "always"],
      ["remote.origin.uploadpack", `touch '${portable(marker)}'; git-upload-pack`],
    ] as const)
      await git("config", key, value);
    // A missing blob makes diff-files --numstat fetch it from the promisor remote.
    const blob = await git("rev-parse", "HEAD:a.txt");
    await rm(path.join(f.root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    await writeFile(path.join(f.root, "a.txt"), "changed\n");

    await expectUnavailable("unsupported_config");
    expect(existsSync(marker)).toBe(false);
    // The runner alone, on a Git that ignores GIT_NO_LAZY_FETCH: every transport is refused.
    const { GIT_NO_LAZY_FETCH: _ignored, ...olderGit } = gitEnvironment(f.directory);
    const fetched = await runGit(f.root, ["diff-files", "--numstat", "-z", "--"], {
      environment: olderGit,
    });
    expect(fetched.kind).toBe("failed");
    expect(existsSync(marker)).toBe(false);
    if (process.platform !== "win32") {
      // Positive control: without these guards the repository's upload-pack command runs.
      const plain = Bun.spawn(["git", "diff-files", "--numstat", "-z", "--"], {
        cwd: f.root,
        env: { PATH: process.env.PATH ?? "", HOME: f.directory },
        stdout: "ignore",
        stderr: "ignore",
      });
      await plain.exited;
      expect(existsSync(marker)).toBe(true);
    }

    for (const key of ["extensions.partialClone", "remote.origin.partialclonefilter"])
      await git("config", "--unset", key);
    await git("config", "core.repositoryformatversion", "0");
    expect(await status()).toMatchObject({ state: "unavailable", reason: "unsupported_config" });
    await git("config", "--unset", "remote.origin.promisor");
    expect((await status()).state).toBe("available");
  });

  test("filters from the user's own Git config keep working; repository-defined ones never run", async () => {
    const home = path.join(f.directory, "home");
    await mkdir(home);
    const marker = path.join(f.directory, "user-filter-ran");
    await writeFile(
      path.join(home, ".gitconfig"),
      `[filter "upper"]\n\tclean = "echo ran >> '${portable(marker)}'; tr a-z A-Z"\n`,
    );
    await writeFile(path.join(f.root, ".gitattributes"), "*.txt filter=upper\n");
    await writeFile(path.join(f.root, "a.txt"), "hello\n");
    await initRepository();
    await git("-c", "filter.upper.clean=tr a-z A-Z", "add", "-A");
    await git("commit", "-m", "Synthetic baseline");
    expect(await git("show", "HEAD:a.txt")).toBe("HELLO");
    // Stat-dirty with unchanged content, as after an editor save or `git lfs pull`.
    const old = new Date("2001-01-01T00:00:00Z");
    await utimes(path.join(f.root, "a.txt"), old, old);
    const saved = Object.entries(process.env).filter(([name]) =>
      /^(home|userprofile)$/i.test(name),
    );
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      expect((await status()).entries).toEqual([]);
      expect((await diff()).files).toEqual([]);
      expect(existsSync(marker)).toBe(true);
      await rm(marker);

      // Any repository key for the same driver neutralises it.
      await git("config", "filter.upper.required", "false");
      expect((await status()).state).toBe("available");
      await diff();
      expect(existsSync(marker)).toBe(false);
      await git("config", "--unset", "filter.upper.required");

      // Git LFS runs repository-configured extensions inside its clean filter.
      await git("config", "lfs.extension.probe.clean", "cat");
      expect((await status()).state).toBe("available");
      expect(existsSync(marker)).toBe(false);
      await git("config", "--unset", "lfs.extension.probe.clean");
      expect((await status()).entries).toEqual([]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      for (const [name, value] of saved) process.env[name] = value;
    }
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
      GIT_ALLOW_PROTOCOL: "<none>",
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

describe("Git runner failures", () => {
  test.skipIf(process.platform === "win32")(
    "a blocked Git process is killed and settles at its deadline",
    async () => {
      const fifo = path.join(f.directory, "blocked-fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      const started = performance.now();
      // Git blocks inside open() until a writer appears; nothing ever writes.
      expect(await runGit(f.root, ["hash-object", "--", fifo], { timeoutMs: 200 })).toEqual({
        kind: "timeout",
      });
      expect(performance.now() - started).toBeLessThan(3000);
      await Bun.sleep(300);
      // A writer can open a FIFO without blocking only while a reader still waits on it.
      let readerAlive = true;
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch (error) {
        readerAlive = (error as NodeJS.ErrnoException).code !== "ENXIO";
      }
      expect(readerAlive).toBe(false);
    },
  );

  test("a missing Git executable reports git_missing", async () => {
    await initRepository();
    const empty = path.join(f.directory, "empty-path");
    await mkdir(empty);
    expect(await readdir(empty)).toEqual([]);
    const saved = Object.entries(process.env).filter(([name]) => /^path$/i.test(name));
    try {
      for (const [name] of saved) delete process.env[name];
      process.env.PATH = empty;
      expect(await runGit(f.root, ["--version"])).toEqual({ kind: "missing" });
      for (const name of ["git_status", "git_diff", "git_log"] as const) {
        const result = await service.call(name, { workspace_id: f.workspace.id }, "mcp");
        expect(result.structuredContent).toMatchObject({
          state: "unavailable",
          reason: "git_missing",
        });
      }
    } finally {
      delete process.env.PATH;
      for (const [name, value] of saved) process.env[name] = value;
    }
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

  test("patch sections start only at complete header lines", () => {
    const text =
      "preamble\ndiff --git a/x b/x\n+diff --git a/y b/y\ndiff --cc y\n@@@ -1 @@@\n* Unmerged path z\ndiff --git a/cut";
    expect(
      patchSections(text).map((section) => [
        section.header,
        text.slice(section.start, section.end),
      ]),
    ).toEqual([
      ["diff --git a/x b/x", "diff --git a/x b/x\n+diff --git a/y b/y\n"],
      ["diff --cc y", "diff --cc y\n@@@ -1 @@@\n"],
      ["* Unmerged path z", "* Unmerged path z\ndiff --git a/cut"],
    ]);
    expect(patchSections("")).toEqual([]);
  });
});
