import { expect, test } from "bun:test";
import { link, mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { type HandoffBaseline, KairomesError } from "@kairomes/protocol";
import { WorkspaceFiles } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { CodexSessionSource } from "./agent-sessions.ts";
import type { CodexConnection } from "./codex-rpc.ts";
import { HandoffBriefs } from "./handoff-brief.ts";

const fields = {
  goal: "完成合成測試",
  next_action: "先核對 README.md",
  completed: "",
  decisions: "",
  unknowns: "",
};
type Started = { draft_id: string };
type Preview = { text: string; digest: string; complete: boolean };
async function preview(briefs: HandoffBriefs, id: string, paths = ["README.md"]) {
  await briefs.perform({ action: "baseline", draft_id: id, paths });
  return briefs.perform({
    action: "preview",
    draft_id: id,
    fields,
    source_stopped: true,
    permissions_checked: true,
  }) as Promise<Preview>;
}
function prepare(briefs: HandoffBriefs, id: string, digest: string) {
  return briefs.perform({
    action: "prepare",
    draft_id: id,
    content_digest: digest,
    source_stopped: true,
    permissions_checked: true,
  });
}

test("H1 copies reviewed minimum context with file_read versions, never source paths or permissions", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    const result = await preview(briefs, draft_id);
    const version = await new WorkspaceFiles(f.registry).read(f.workspace.id, "README.md");
    expect(result.complete).toBe(true);
    expect(result.text).toContain(version.version);
    expect(result.text).toContain(f.workspace.id);
    expect(result.text).not.toContain(f.root);
    expect(result.text).not.toContain("sessionId");
    expect(await prepare(briefs, draft_id, result.digest)).toEqual({
      text: result.text,
      digest: result.digest,
      state: "ready-to-copy",
    });
    expect(result.text).toContain("不移轉");
    expect(result.text).not.toContain("已接手");
    const edited = (await briefs.perform({
      action: "preview",
      draft_id,
      fields: { ...fields, next_action: "另一個下一步" },
      source_stopped: true,
      permissions_checked: true,
    })) as Preview;
    expect(edited.digest).not.toBe(result.digest);
    await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
      code: "HANDOFF_REVIEW",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 finite manifests distinguish unavailable Git from unborn HEAD and retain rename/delete evidence", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  const git = async (...args: string[]) => {
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
      { stdout: "ignore", stderr: "ignore", windowsHide: true },
    );
    expect(await command.exited).toBe(0);
  };
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    const nonGit = await preview(briefs, draft_id);
    expect(nonGit.complete).toBe(true);
    expect(nonGit.text).toContain("unknown（Git 無法核對）");
    expect(nonGit.text).toContain("未選入內容未核對");
    expect(await prepare(briefs, draft_id, nonGit.digest)).toMatchObject({
      state: "ready-to-copy",
    });
    await git("init", "--initial-branch=main", "--template=");
    const unborn = await preview(briefs, draft_id);
    expect(unborn.complete).toBe(true);
    expect(unborn.text).toContain("本機 HEAD：無 commit");
    expect(unborn.text).not.toContain("Git 無法核對");
    expect(await prepare(briefs, draft_id, unborn.digest)).toMatchObject({
      state: "ready-to-copy",
    });
    await git("add", "--", "README.md", "src/main.ts");
    await git("commit", "-m", "Synthetic fixture baseline");
    await git("mv", "--", "README.md", "GUIDE.md");
    await unlink(path.join(f.root, "src/main.ts"));
    const checked = (await briefs.perform({
      action: "baseline",
      draft_id,
      paths: ["GUIDE.md", "src/main.ts"],
    })) as HandoffBaseline;
    expect(checked.complete).toBe(false);
    expect(checked.files[1]).toMatchObject({
      path: "src/main.ts",
      state: "unknown",
      version: null,
    });
    expect(checked.git.dirty).toContainEqual({
      status: "R ",
      path: "GUIDE.md",
      previousPath: "README.md",
    });
    expect(checked.git.dirty).toContainEqual({ status: " D", path: "src/main.ts" });
    const missing = (await briefs.perform({
      action: "preview",
      draft_id,
      fields,
      source_stopped: true,
      permissions_checked: true,
    })) as Preview;
    expect(missing.complete).toBe(false);
    await expect(prepare(briefs, draft_id, missing.digest)).rejects.toMatchObject({
      code: "HANDOFF_INCOMPLETE",
    });
    const finite = await preview(briefs, draft_id, ["GUIDE.md"]);
    expect(finite.complete).toBe(true);
    expect(finite.text).toContain("未選入內容未核對");
    expect(finite.text).not.toContain(f.root);
    expect(await prepare(briefs, draft_id, finite.digest)).toMatchObject({
      state: "ready-to-copy",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 changes to content, dirty files, mount and root identity invalidate readiness", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const started = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    const first = await preview(briefs, started.draft_id);
    await writeFile(path.join(f.root, "README.md"), "Changed without a HEAD change");
    await expect(prepare(briefs, started.draft_id, first.digest)).rejects.toMatchObject({
      code: "HANDOFF_STALE",
    });
    await expect(prepare(briefs, started.draft_id, first.digest)).rejects.toMatchObject({
      code: "HANDOFF_REVIEW",
    });
    const second = await preview(briefs, started.draft_id);
    f.registry.remove(f.workspace.id);
    await expect(prepare(briefs, started.draft_id, second.digest)).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
    const remounted = await f.registry.add(f.root);
    const rootDraft = (await briefs.perform({
      action: "start",
      workspace_id: remounted.id,
      provider: "manual",
    })) as Started;
    const rootPreview = await preview(briefs, rootDraft.draft_id);
    await rename(f.root, `${f.root}-old`);
    await mkdir(f.root);
    await expect(prepare(briefs, rootDraft.draft_id, rootPreview.digest)).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 refuses unknown, absent, linked, binary and oversized baseline as ready", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    await writeFile(path.join(f.root, "binary.dat"), Buffer.from([0, 1]));
    await writeFile(path.join(f.root, "large.txt"), "a".repeat(1024 * 1024 + 1));
    await link(path.join(f.root, "src/main.ts"), path.join(f.root, "hard.txt"));
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    for (const paths of [[], ["missing.txt"], ["binary.dat"], ["large.txt"], ["hard.txt"]]) {
      const result = await preview(briefs, draft_id, paths);
      expect(result.complete).toBe(false);
      await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
        code: "HANDOFF_INCOMPLETE",
      });
    }
    await writeFile(path.join(f.state, "outside.txt"), "Synthetic external content");
    await symlink(
      f.state,
      path.join(f.root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linked = await preview(briefs, draft_id, ["outside/outside.txt"]);
    expect(linked.complete).toBe(false);
    await expect(prepare(briefs, draft_id, linked.digest)).rejects.toMatchObject({
      code: "HANDOFF_INCOMPLETE",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 strict size/path limits and sensitive fields fail before clipboard preparation", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    for (const paths of [
      ["../private.txt"],
      ["C:/secret.txt"],
      [".env"],
      ["README.md", "README.md"],
    ])
      await expect(briefs.perform({ action: "baseline", draft_id, paths })).rejects.toBeInstanceOf(
        Error,
      );
    await expect(
      briefs.perform({
        action: "baseline",
        draft_id,
        paths: Array.from({ length: 21 }, (_, i) => `${i}.txt`),
      }),
    ).rejects.toBeInstanceOf(Error);
    await preview(briefs, draft_id);
    for (const goal of [
      `sk-proj-${"a".repeat(30)}`,
      "http://127.0.0.1:1234/#token=secret",
      "C:/private/file.txt",
    ])
      await expect(
        briefs.perform({
          action: "preview",
          draft_id,
          fields: { ...fields, goal },
          source_stopped: true,
          permissions_checked: true,
        }),
      ).rejects.toMatchObject({ code: "HANDOFF_PRIVATE" });
    await expect(
      briefs.perform({
        action: "preview",
        draft_id,
        fields: { ...fields, goal: "x".repeat(501) },
        source_stopped: true,
        permissions_checked: true,
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      briefs.perform({
        action: "start",
        workspace_id: f.workspace.id,
        provider: "manual",
        token: "not-allowed",
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      briefs.perform({
        action: "prepare",
        draft_id,
        content_digest: "a".repeat(64),
        source_stopped: false,
        permissions_checked: true,
      }),
    ).rejects.toBeInstanceOf(Error);
    const unconfirmed = (await briefs.perform({
      action: "preview",
      draft_id,
      fields,
      source_stopped: false,
      permissions_checked: true,
    })) as Preview;
    await expect(prepare(briefs, draft_id, unconfirmed.digest)).rejects.toMatchObject({
      code: "HANDOFF_ATTESTATION",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 total read budget stops at 8 MiB and its version helper enforces the remaining bytes", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const paths = Array.from({ length: 9 }, (_, i) => `file-${i}.txt`);
    for (const relative of paths)
      await writeFile(path.join(f.root, relative), "a".repeat(1024 * 1024));
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    const baseline = (await briefs.perform({ action: "baseline", draft_id, paths })) as {
      total_bytes: number;
      complete: boolean;
      files: { state: string }[];
    };
    expect(baseline.total_bytes).toBe(8 * 1024 * 1024);
    expect(baseline.complete).toBe(false);
    expect(baseline.files[8]?.state).toBe("unknown");
    await expect(
      new WorkspaceFiles(f.registry).version(f.workspace.id, "README.md", 1),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      new WorkspaceFiles(f.registry).version(f.workspace.id, "README.md", -1),
    ).rejects.toMatchObject({ code: "FILE_LIMIT" });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 oversized clipboard content stays a draft without silently truncating decisions", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const paths = Array.from({ length: 20 }, (_, i) => `file-${i}-${"a".repeat(40)}.txt`);
    for (const relative of paths) await writeFile(path.join(f.root, relative), "Synthetic");
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    await briefs.perform({ action: "baseline", draft_id, paths });
    await expect(
      briefs.perform({
        action: "preview",
        draft_id,
        fields: {
          goal: "a".repeat(500),
          next_action: "b".repeat(500),
          completed: "c".repeat(1000),
          decisions: "d".repeat(1000),
          unknowns: "e".repeat(1000),
        },
        source_stopped: true,
        permissions_checked: true,
      }),
    ).rejects.toMatchObject({ code: "HANDOFF_TEXT" });
    await expect(prepare(briefs, draft_id, "a".repeat(64))).rejects.toMatchObject({
      code: "HANDOFF_REVIEW",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

class ReadOnlyFake implements CodexConnection {
  cwd: string;
  pending = false;
  status = "idle";
  readFailure = false;
  turnItems: Record<string, unknown>[] = [
    { type: "agentMessage", text: "Do not auto-copy this transcript" },
  ];
  readGate?: Promise<void>;
  reading = false;
  calls: string[] = [];
  closed = false;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  async start() {}
  async close() {
    this.closed = true;
  }
  async request(method: string) {
    this.calls.push(method);
    const thread = {
      id: "selected",
      cwd: this.cwd,
      updatedAt: 1,
      name: "合成來源",
      status: { type: this.status },
    };
    if (method === "thread/list") return { data: [thread], nextCursor: null };
    if (method === "thread/read") {
      this.reading = true;
      if (this.readGate) await this.readGate;
      if (this.readFailure) throw new Error("SYNTHETIC_PRIVATE_RPC_DETAILS");
      return { thread };
    }
    if (method === "thread/turns/list")
      return {
        data: [
          {
            id: "one",
            status: this.pending ? "inProgress" : "completed",
            items: this.turnItems,
          },
        ],
        nextCursor: null,
      };
    throw new Error("Mutation is forbidden");
  }
}

test("H1 exports count-clipped source coverage without conflating safe omissions", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  const briefs = new HandoffBriefs(f.registry, (root) => CodexSessionSource.open(rpc, root));
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    for (const [kind, count] of [
      ["agentMessage", 32],
      ["agentMessage", 33],
      ["commandExecution", 40],
      ["commandExecution", 41],
    ] as const) {
      rpc.turnItems = [
        ...Array.from({ length: 50 }, () => ({ type: "reasoning", content: "PRIVATE" })),
        ...Array.from({ length: count }, (_, index) =>
          kind === "agentMessage"
            ? { type: kind, text: `message-${index}` }
            : { type: kind, command: `command-${index}`, status: "completed", exitCode: 0 },
        ),
      ];
      await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
      const result = await preview(briefs, draft_id);
      const clipped = count > (kind === "agentMessage" ? 32 : 40);
      expect(result.complete).toBe(true);
      expect(result.text).toContain(`截斷${clipped ? "有" : "無"}`);
      expect(result.text).not.toContain(`截斷${clipped ? "無" : "有"}`);
      expect(result.text).not.toContain("PRIVATE");
      expect(await prepare(briefs, draft_id, result.digest)).toMatchObject({
        text: result.text,
        state: "ready-to-copy",
      });
    }
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 unknown, unavailable, failed and active sources stay review-only despite a stop attestation", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  const briefs = new HandoffBriefs(f.registry, (root) => CodexSessionSource.open(rpc, root));
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    for (const status of [
      "unknown",
      "futureStatus",
      "systemError",
      "error",
      "unavailable",
      "inProgress",
      "active",
      "running",
    ]) {
      rpc.status = status;
      await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
      const result = (await preview(briefs, draft_id)) as Preview & { blocked_reason: string };
      expect(result.complete).toBe(false);
      expect(result.blocked_reason).toBeTruthy();
      expect(result.text).toContain(result.blocked_reason);
      await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
        code: ["inProgress", "active", "running"].includes(status)
          ? "HANDOFF_PENDING"
          : "HANDOFF_SOURCE_STATE",
      });
      await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
        code: "HANDOFF_REVIEW",
      });
    }
    rpc.status = "idle";
    rpc.pending = true;
    await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
    const pending = await preview(briefs, draft_id);
    expect(pending.complete).toBe(false);
    await expect(prepare(briefs, draft_id, pending.digest)).rejects.toMatchObject({
      code: "HANDOFF_PENDING",
    });
    rpc.pending = false;
    for (const status of ["idle", "notLoaded"]) {
      rpc.status = status;
      await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
      const result = await preview(briefs, draft_id);
      expect(result.complete).toBe(true);
      expect(await prepare(briefs, draft_id, result.digest)).toMatchObject({
        state: "ready-to-copy",
      });
      const unconfirmed = (await briefs.perform({
        action: "preview",
        draft_id,
        fields,
        source_stopped: false,
        permissions_checked: true,
      })) as Preview;
      await expect(prepare(briefs, draft_id, unconfirmed.digest)).rejects.toMatchObject({
        code: "HANDOFF_ATTESTATION",
      });
    }
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 disconnected source invalidates review, hides RPC details and permits a new manual draft", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  const briefs = new HandoffBriefs(f.registry, (root) => CodexSessionSource.open(rpc, root));
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
    const result = await preview(briefs, draft_id);
    rpc.readFailure = true;
    const failure = await prepare(briefs, draft_id, result.digest).catch((error) => error);
    if (!(failure instanceof KairomesError)) throw new Error("Expected a public handoff failure");
    expect(failure.code).toBe("HANDOFF_SOURCE_STATE");
    expect(failure.message).toContain("手動摘要");
    expect(failure.message).not.toContain("SYNTHETIC_PRIVATE_RPC_DETAILS");
    await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
      code: "HANDOFF_REVIEW",
    });
    const retry = (await preview(briefs, draft_id)) as Preview & { blocked_reason: string };
    expect(retry.complete).toBe(false);
    expect(retry.blocked_reason).toContain("無法核對");
    await briefs.perform({ action: "cancel", draft_id });
    expect(rpc.closed).toBe(true);
    const manual = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
    })) as Started;
    const manualPreview = await preview(briefs, manual.draft_id);
    expect(manualPreview.complete).toBe(true);
    expect(await prepare(briefs, manual.draft_id, manualPreview.digest)).toMatchObject({
      state: "ready-to-copy",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 cancellation during source recheck rejects the late response and closes its reader", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  const briefs = new HandoffBriefs(f.registry, (root) => CodexSessionSource.open(rpc, root));
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    await briefs.perform({ action: "snapshot", draft_id, session_id: "selected" });
    const result = await preview(briefs, draft_id);
    let release = () => {};
    rpc.readGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rpc.reading = false;
    const preparing = prepare(briefs, draft_id, result.digest).catch((error) => error);
    const deadline = Date.now() + 1000;
    while (!rpc.reading && Date.now() < deadline) await Bun.sleep(5);
    expect(rpc.reading).toBe(true);
    await briefs.perform({ action: "cancel", draft_id });
    expect(rpc.closed).toBe(true);
    release();
    expect(await preparing).toMatchObject({ code: "HANDOFF_CANCELLED" });
    await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
      code: "HANDOFF_EXPIRED",
    });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 source is explicit, same-realpath, listed only and source changes fail before copy", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  const briefs = new HandoffBriefs(f.registry, (root) => CodexSessionSource.open(rpc, root));
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    await expect(
      briefs.perform({ action: "snapshot", draft_id, session_id: "invented" }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE" });
    const { snapshot } = (await briefs.perform({
      action: "snapshot",
      draft_id,
      session_id: "selected",
    })) as { snapshot: object };
    expect(JSON.stringify(snapshot)).not.toContain(f.root);
    const result = await preview(briefs, draft_id);
    expect(result.text).not.toContain("Do not auto-copy");
    rpc.pending = true;
    await expect(prepare(briefs, draft_id, result.digest)).rejects.toMatchObject({
      code: "HANDOFF_PENDING",
    });
    rpc.pending = false;
    rpc.cwd = f.state;
    await expect(
      briefs.perform({ action: "snapshot", draft_id, session_id: "selected" }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE" });
    await briefs.perform({ action: "cancel", draft_id });
    expect(rpc.closed).toBe(true);
    expect(
      rpc.calls.every((method) =>
        ["thread/list", "thread/read", "thread/turns/list"].includes(method),
      ),
    ).toBe(true);
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 cancellation and expiry discard source resources and never restore stale drafts", async () => {
  const f = await fixture();
  const rpc = new ReadOnlyFake(f.root);
  let clock = Date.now();
  const briefs = new HandoffBriefs(
    f.registry,
    (root) => CodexSessionSource.open(rpc, root),
    () => clock,
  );
  try {
    const { draft_id } = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "codex",
    })) as Started;
    clock += 11 * 60 * 1000;
    await expect(
      briefs.perform({ action: "snapshot", draft_id, session_id: "selected" }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
    await briefs.perform({ action: "cancel", draft_id });
    expect(rpc.closed).toBe(true);
    await expect(
      briefs.perform({ action: "baseline", draft_id, paths: ["README.md"] }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      briefs.perform(
        { action: "start", workspace_id: f.workspace.id, provider: "codex" },
        aborted.signal,
      ),
    ).rejects.toMatchObject({ code: "HANDOFF_CANCELLED" });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 simultaneous starts reserve only four readers and refuse duplicate draft IDs", async () => {
  const f = await fixture();
  let readers = 0;
  const briefs = new HandoffBriefs(f.registry, async (root) => {
    readers++;
    return CodexSessionSource.open(new ReadOnlyFake(root), root);
  });
  try {
    const starts = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        briefs.perform({ action: "start", workspace_id: f.workspace.id, provider: "codex" }),
      ),
    );
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(readers).toBe(4);
    for (const result of starts)
      if (result.status === "rejected") expect(result.reason.code).toBe("HANDOFF_LIMIT");
    for (const result of starts)
      if (result.status === "fulfilled")
        await briefs.perform({ action: "cancel", draft_id: (result.value as Started).draft_id });
    const draft_id = crypto.randomUUID();
    await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
      draft_id,
    });
    await expect(
      briefs.perform({
        action: "start",
        workspace_id: f.workspace.id,
        provider: "manual",
        draft_id,
      }),
    ).rejects.toMatchObject({ code: "HANDOFF_DUPLICATE" });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 explicit cancellation aborts a reader still opening, rather than waiting for its TTL", async () => {
  const f = await fixture();
  let opening = false;
  let aborted = false;
  const briefs = new HandoffBriefs(
    f.registry,
    async (_root, signal) =>
      new Promise((_, reject) => {
        opening = true;
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new KairomesError("HANDOFF_CANCELLED", "已取消來源讀取。"));
          },
          { once: true },
        );
      }),
  );
  try {
    const draft_id = crypto.randomUUID();
    const pending = briefs
      .perform({ action: "start", workspace_id: f.workspace.id, provider: "codex", draft_id })
      .catch((error) => error);
    const deadline = Date.now() + 1000;
    while (!opening && Date.now() < deadline) await Bun.sleep(5);
    expect(opening).toBe(true);
    await briefs.perform({ action: "cancel", draft_id });
    expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(aborted).toBe(true);
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 immediate cancellation before path validation prevents any source from opening", async () => {
  const f = await fixture();
  let readers = 0;
  const briefs = new HandoffBriefs(f.registry, async (root) => {
    readers++;
    return CodexSessionSource.open(new ReadOnlyFake(root), root);
  });
  try {
    const draft_id = crypto.randomUUID();
    const pending = briefs
      .perform({ action: "start", workspace_id: f.workspace.id, provider: "codex", draft_id })
      .catch((error) => error);
    expect(await briefs.perform({ action: "cancel", draft_id })).toEqual({ cancelled: true });
    expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(readers).toBe(0);
    await expect(briefs.perform({ action: "baseline", draft_id, paths: [] })).rejects.toMatchObject(
      { code: "HANDOFF_EXPIRED" },
    );
    const replacement = (await briefs.perform({
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
      draft_id,
    })) as Started;
    expect(replacement.draft_id).toBe(draft_id);
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 duplicate UUID is refused while the first start is still validating paths", async () => {
  const f = await fixture();
  const briefs = new HandoffBriefs(f.registry);
  try {
    const input = {
      action: "start",
      workspace_id: f.workspace.id,
      provider: "manual",
      draft_id: crypto.randomUUID(),
    };
    const pending = briefs.perform(input);
    await expect(briefs.perform(input)).rejects.toMatchObject({ code: "HANDOFF_DUPLICATE" });
    expect(await pending).toMatchObject({ draft_id: input.draft_id });
  } finally {
    await briefs.close();
    await f.dispose();
  }
});

test("H1 cancelled source late resolve or failure cannot read or discard a replacement UUID", async () => {
  for (const result of ["resolve", "reject"] as const) {
    const f = await fixture();
    let entered = () => {};
    const opening = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (_source: {
      list(): Promise<{ sessions: []; nextCursor: null }>;
      snapshot(): Promise<never>;
      close(): Promise<void>;
    }) => {};
    let reject = (_error: Error) => {};
    let reads = 0;
    let closes = 0;
    let aborted: AbortSignal | undefined;
    const source = {
      async list() {
        reads++;
        return { sessions: [] as [], nextCursor: null };
      },
      async snapshot(): Promise<never> {
        throw new Error("Unused synthetic source read");
      },
      async close() {
        closes++;
      },
    };
    const briefs = new HandoffBriefs(f.registry, async (_root, signal) => {
      aborted = signal;
      entered();
      return new Promise((resolve, rejectSource) => {
        release = resolve;
        reject = rejectSource;
      });
    });
    try {
      const draft_id = crypto.randomUUID();
      const oldStart = briefs
        .perform({ action: "start", workspace_id: f.workspace.id, provider: "codex", draft_id })
        .catch((error) => error);
      await opening;
      await briefs.perform({ action: "cancel", draft_id });
      expect(aborted?.aborted).toBe(true);
      await briefs.perform({
        action: "start",
        workspace_id: f.workspace.id,
        provider: "manual",
        draft_id,
      });
      if (result === "resolve") release(source);
      else reject(new Error("Synthetic opening failed after cancellation"));
      const oldResult = await oldStart;
      if (result === "resolve") expect(oldResult).toMatchObject({ code: "HANDOFF_CANCELLED" });
      else {
        if (!(oldResult instanceof Error)) throw new Error("Expected a synthetic opening failure");
        expect(oldResult.message).toContain("Synthetic opening failed");
      }
      expect(reads).toBe(0);
      expect(closes).toBe(result === "resolve" ? 1 : 0);
      expect(
        await briefs.perform({ action: "baseline", draft_id, paths: ["README.md"] }),
      ).toMatchObject({ complete: true });
    } finally {
      await briefs.close();
      await f.dispose();
    }
  }
});
