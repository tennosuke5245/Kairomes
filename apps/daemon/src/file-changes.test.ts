import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileChangeInputs, FileChangeResultSchema } from "@kairomes/protocol";
import { WorkspaceFiles } from "@kairomes/workspace-core";
import { fixture } from "../../../tests/fixtures.ts";
import { FileChangeManager } from "./file-changes.ts";
import { ToolService } from "./tools.ts";

async function editInput(f: Awaited<ReturnType<typeof fixture>>, requestId = crypto.randomUUID()) {
  const current = await new WorkspaceFiles(f.registry).read(f.workspace.id, "README.md");
  return {
    workspace_id: f.workspace.id,
    request_id: requestId,
    summary: "更新 README 問候語",
    changes: [
      {
        operation: "edit" as const,
        path: "README.md",
        expected_version: current.version,
        replacements: [
          {
            old_text: "Hello Kairomes",
            new_text: "Hello Kairomes 喵",
            replace_all: false,
          },
        ],
      },
    ],
  };
}

test("structured file changes stay inert until trusted approval and retry only once", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const input = await editInput(f);
    const [first, retry] = await Promise.all([
      service.changes.request(input, "mcp"),
      service.changes.request(input, "mcp"),
    ]);
    expect(first.change.id).toBe(retry.change.id);
    expect(first.change.state).toBe("pending");
    expect(await Bun.file(`${f.root}/README.md`).text()).not.toContain("喵");
    const approval = service.changes.approvals().find((item) => item.id === first.change.id);
    expect(approval?.diff).toContain("+Hello Kairomes 喵");
    await expect(service.changes.decide(first.change.id, "bad", true)).rejects.toThrow("不一致");
    await expect(service.changes.request({ ...input, summary: "不同請求" })).rejects.toThrow(
      "不同",
    );
    await service.changes.decide(first.change.id, approval?.fingerprint ?? "", true);
    expect(service.changes.poll(first.change.id).change.state).toBe("applied");
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("Hello Kairomes 喵");
    expect(service.activity.list().filter((entry) => entry.kind === "file_change")).toHaveLength(1);
    expect((await service.changes.request(input)).change.id).toBe(first.change.id);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("approval never overwrites a file changed after review", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const requested = await service.changes.request(await editInput(f), "mcp");
    const approval = service.changes.approvals().find((item) => item.id === requested.change.id);
    await writeFile(`${f.root}/README.md`, "# Human edit\n");
    await service.changes.decide(requested.change.id, approval?.fingerprint ?? "", true);
    const result = service.changes.poll(requested.change.id);
    expect(result.change.state).toBe("conflict");
    expect(result.change.message).toContain("改變");
    expect(await Bun.file(`${f.root}/README.md`).text()).toBe("# Human edit\n");
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("the model gets a bounded diff while native approval keeps the complete review", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const marker = "END-OF-REVIEW";
    const requested = await service.changes.request({
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      summary: "建立較長的文字檔",
      changes: [
        {
          operation: "write",
          path: "long-review.txt",
          expected_version: null,
          content: `${"x".repeat(55 * 1024)}${marker}\n`,
        },
      ],
    });
    expect(requested.diff_truncated).toBe(true);
    expect(requested.diff).not.toContain(marker);
    const approval = service.changes.approvals().find((item) => item.id === requested.change.id);
    expect(approval?.diff_truncated).toBe(false);
    expect(approval?.diff).toContain(marker);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("denial, cancellation, expiry and full access have distinct behavior", async () => {
  const f = await fixture();
  let now = Date.now();
  let grant = false;
  const manager = new FileChangeManager(
    f.registry,
    () =>
      grant
        ? {
            id: "grant",
            workspace_id: f.workspace.id,
            workspace_name: "測試專案",
            level: "files" as const,
            expires_at: now + 60_000,
          }
        : undefined,
    () => {},
    () => now,
  );
  try {
    const denied = await manager.request(await editInput(f));
    const deniedApproval = manager.approvals().find((item) => item.id === denied.change.id);
    await manager.decide(denied.change.id, deniedApproval?.fingerprint ?? "", false);
    expect(manager.poll(denied.change.id).change.state).toBe("denied");

    const cancelled = await manager.request(await editInput(f));
    expect(manager.cancel(cancelled.change.id).change.state).toBe("cancelled");

    const expired = await manager.request(await editInput(f));
    now += 300_001;
    manager.maintain();
    expect(manager.poll(expired.change.id).change.state).toBe("expired");

    grant = true;
    const automatic = await manager.request(await editInput(f));
    expect(automatic.change.state).toBe("applied");
    expect(await Bun.file(`${f.root}/README.md`).text()).toContain("喵");
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("file autonomy applies structured edits but never grants commands or host terminals", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    await service.enableAccess(f.workspace.id, "files", null, "owner", () => true);
    const changed = await service.changes.request(await editInput(f), "mcp");
    expect(changed.change.state).toBe("applied");
    const command = await service.commands.request({
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
      argv: ["bun", "--version"],
    });
    expect(command.command.state).toBe("pending");
    const terminal = await service.terminals.request({
      workspace_id: f.workspace.id,
      cwd: "",
      shell: process.platform === "win32" ? "cmd" : "bash",
      cols: 80,
      rows: 24,
    });
    expect(terminal.session.state).toBe("pending");
  } finally {
    await service.close();
    await f.dispose();
  }
});

const folderInput = (f: Awaited<ReturnType<typeof fixture>>, folder = "assets/new") => ({
  workspace_id: f.workspace.id,
  request_id: crypto.randomUUID(),
  summary: "建立圖片資料夾與說明",
  changes: [
    { operation: "mkdir" as const, path: `${folder}/images` },
    {
      operation: "write" as const,
      path: `${folder}/README.md`,
      expected_version: null,
      content: "# New\n",
    },
  ],
});

test("new folders wait for approval, are shown in the view and bound to the fingerprint", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const input = folderInput(f);
    const requested = await service.changes.request(input, "mcp");
    expect(requested.change.state).toBe("pending");
    expect(requested.change.files).toEqual([
      {
        operation: "mkdir",
        path: "assets/new/images",
        before_version: null,
        after_version: null,
        created_folders: ["assets/", "assets/new/", "assets/new/images/"],
      },
      expect.objectContaining({ operation: "write", path: "assets/new/README.md" }),
    ]);
    expect(requested.change.files[1]).not.toHaveProperty("created_folders");
    expect(requested.diff).toContain("+++ b/assets/new/images/\n@@ create folder @@");
    expect(existsSync(`${f.root}/assets`)).toBe(false);

    // Recompute the fingerprint from the same fields; dropping the folders must not verify.
    const approval = service.changes.approvals().find((item) => item.id === requested.change.id);
    if (!approval) throw new Error("missing approval");
    const sha = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const inputHash = sha(FileChangeInputs.file_change_request.parse(input));
    const bind = (files: typeof approval.files, diff: string) =>
      sha({ id: approval.id, inputHash, files, diff, diffTruncated: approval.diff_truncated });
    expect(bind(approval.files, approval.diff)).toBe(approval.fingerprint);
    const withoutFolderDiff = approval.diff
      .split("\n\n")
      .filter((entry) => !entry.includes("@@ create folder @@"))
      .join("\n\n");
    const withoutFolderFiles = approval.files.map(({ created_folders: _, ...file }) => file);
    expect(withoutFolderDiff).not.toBe(approval.diff);
    for (const forged of [
      bind(approval.files, withoutFolderDiff),
      bind(withoutFolderFiles, approval.diff),
    ])
      await expect(service.changes.decide(requested.change.id, forged, true)).rejects.toMatchObject(
        { code: "APPROVAL_MISMATCH" },
      );
    expect(existsSync(`${f.root}/assets`)).toBe(false);

    await service.changes.decide(requested.change.id, approval.fingerprint, true);
    expect(service.changes.poll(requested.change.id).change.state).toBe("applied");
    expect((await lstat(`${f.root}/assets/new/images`)).isDirectory()).toBe(true);
    expect(await Bun.file(`${f.root}/assets/new/README.md`).text()).toBe("# New\n");
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("denied, cancelled and expired folder changes create nothing; files autonomy applies", async () => {
  const f = await fixture();
  let now = Date.now();
  let grant = false;
  const manager = new FileChangeManager(
    f.registry,
    () =>
      grant
        ? {
            id: "grant",
            workspace_id: f.workspace.id,
            workspace_name: "測試專案",
            level: "files" as const,
            expires_at: now + 60_000,
          }
        : undefined,
    () => {},
    () => now,
  );
  try {
    const denied = await manager.request(folderInput(f, "denied"));
    const approval = manager.approvals().find((item) => item.id === denied.change.id);
    await manager.decide(denied.change.id, approval?.fingerprint ?? "", false);
    const cancelled = await manager.request(folderInput(f, "cancelled"));
    manager.cancel(cancelled.change.id);
    const expired = await manager.request(folderInput(f, "expired"));
    now += 300_001;
    manager.maintain();
    expect(manager.poll(expired.change.id).change.state).toBe("expired");
    for (const folder of ["denied", "cancelled", "expired"])
      expect(existsSync(`${f.root}/${folder}`)).toBe(false);

    grant = true;
    const automatic = await manager.request(folderInput(f, "automatic"));
    expect(automatic.change.state).toBe("applied");
    expect((await lstat(`${f.root}/automatic/images`)).isDirectory()).toBe(true);
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("a planned folder replaced after review ends as a conflict without writing", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const requested = await service.changes.request(folderInput(f, "taken"), "mcp");
    await writeFile(`${f.root}/taken`, "a file now\n");
    const approval = service.changes.approvals().find((item) => item.id === requested.change.id);
    await service.changes.decide(requested.change.id, approval?.fingerprint ?? "", true);
    expect(service.changes.poll(requested.change.id).change.state).toBe("conflict");
    expect(await Bun.file(`${f.root}/taken`).text()).toBe("a file now\n");
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("an existing parent swapped for a link after review ends as a conflict", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const outside = path.join(f.directory, "outside");
    await mkdir(outside);
    await mkdir(`${f.root}/existing`);
    const requested = await service.changes.request(folderInput(f, "existing/new"), "mcp");
    await rename(`${f.root}/existing`, `${f.root}/existing-old`);
    await symlink(outside, `${f.root}/existing`, process.platform === "win32" ? "junction" : "dir");
    const approval = service.changes.approvals().find((item) => item.id === requested.change.id);
    await service.changes.decide(requested.change.id, approval?.fingerprint ?? "", true);
    expect(service.changes.poll(requested.change.id).change.state).toBe("conflict");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("a mkdir path at the 1024-character limit keeps request and list output valid", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const folder = ["src", "a".repeat(254), "b".repeat(255), "c".repeat(255), "d".repeat(253)].join(
      "/",
    );
    expect(folder).toHaveLength(1024);
    const requested = await service.call(
      "file_change_request",
      {
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        summary: "建立很長的資料夾",
        changes: [{ operation: "mkdir", path: folder }],
      },
      "mcp",
    );
    expect(requested.isError).toBeUndefined();
    const listed = await service.call("file_change_list", {}, "mcp");
    expect(listed.isError).toBeUndefined();
    expect(JSON.stringify(listed.structuredContent)).toContain(`${folder}/`);
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("folder limits are request-time errors", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    await expect(
      service.changes.request({
        workspace_id: f.workspace.id,
        request_id: crypto.randomUUID(),
        summary: "太深",
        changes: [{ operation: "mkdir", path: "a/b/c/d/e" }],
      }),
    ).rejects.toMatchObject({ code: "FOLDER_LIMIT" });
    expect(service.changes.list()).toEqual([]);
  } finally {
    await service.close();
    await f.dispose();
  }
});

/** Approves one pending change the way the trusted panel does, with its current fingerprint. */
async function approve(manager: FileChangeManager, id: string) {
  const approval = manager.approvals().find((item) => item.id === id);
  await manager.decide(id, approval?.fingerprint ?? "", true);
  return manager.poll(id).change;
}

test("a revert is an ordinary pending change that restores the applied batch once approved", async () => {
  const f = await fixture();
  const manager = new FileChangeManager(f.registry, () => undefined);
  try {
    const original = await readFile(`${f.root}/README.md`);
    const applied = await manager.request(await editInput(f), "mcp");
    expect((await approve(manager, applied.change.id)).state).toBe("applied");
    const afterApply = await readFile(`${f.root}/README.md`);

    const requestId = crypto.randomUUID();
    const [revert, retry] = await Promise.all([
      manager.revert(applied.change.id, requestId, "mcp"),
      manager.revert(applied.change.id, requestId, "mcp"),
    ]);
    expect(retry.change.id).toBe(revert.change.id);
    expect(revert.change).toMatchObject({
      state: "pending",
      workspace_id: f.workspace.id,
      request_id: requestId,
      summary: "復原：更新 README 問候語",
      reverts_change_id: applied.change.id,
    });
    expect(revert.change.id).not.toBe(applied.change.id);
    expect(revert.change.files).toEqual([
      {
        operation: "write",
        path: "README.md",
        before_version: applied.change.files[0]?.after_version ?? null,
        after_version: applied.change.files[0]?.before_version ?? null,
      },
    ]);
    expect(revert.diff).toContain("-Hello Kairomes 喵\n+Hello Kairomes");
    // Nothing is written until the local user approves the inverse batch.
    expect(await readFile(`${f.root}/README.md`)).toEqual(afterApply);
    expect(manager.poll(applied.change.id).change.state).toBe("applied");
    await expect(manager.revert(crypto.randomUUID(), requestId, "mcp")).rejects.toMatchObject({
      code: "FILE_CHANGE_REQUEST_CONFLICT",
    });
    await expect(
      manager.request({ ...(await editInput(f)), request_id: requestId }),
    ).rejects.toMatchObject({ code: "FILE_CHANGE_REQUEST_CONFLICT" });

    expect((await approve(manager, revert.change.id)).state).toBe("applied");
    expect(await readFile(`${f.root}/README.md`)).toEqual(original);
    expect(manager.poll(applied.change.id).change.state).toBe("applied");
    // The same request_id still returns the finished revert instead of proposing another.
    expect((await manager.revert(applied.change.id, requestId)).change.id).toBe(revert.change.id);
    // The original no longer matches the files, so a second revert of it is refused.
    await expect(manager.revert(applied.change.id, crypto.randomUUID())).rejects.toMatchObject({
      code: "REVERT_CONFLICT",
    });

    // Reverting the revert is a redo.
    const redo = await manager.revert(revert.change.id, crypto.randomUUID());
    expect(redo.change.summary).toBe("復原：復原：更新 README 問候語");
    expect(redo.change.reverts_change_id).toBe(revert.change.id);
    expect((await approve(manager, redo.change.id)).state).toBe("applied");
    expect(await readFile(`${f.root}/README.md`)).toEqual(afterApply);
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("only applied changes that are still retained can be reverted", async () => {
  const f = await fixture();
  const manager = new FileChangeManager(f.registry, () => undefined);
  try {
    const unavailable = { code: "REVERT_UNAVAILABLE" };
    const pending = await manager.request(await editInput(f));
    await expect(manager.revert(pending.change.id, crypto.randomUUID())).rejects.toMatchObject(
      unavailable,
    );
    manager.cancel(pending.change.id);
    await expect(manager.revert(pending.change.id, crypto.randomUUID())).rejects.toMatchObject(
      unavailable,
    );
    const denied = await manager.request(await editInput(f));
    const deniedApproval = manager.approvals().find((item) => item.id === denied.change.id);
    await manager.decide(denied.change.id, deniedApproval?.fingerprint ?? "", false);
    await expect(manager.revert(denied.change.id, crypto.randomUUID())).rejects.toMatchObject(
      unavailable,
    );
    const conflict = await manager.request(await editInput(f));
    await writeFile(`${f.root}/README.md`, "# Human edit\n");
    expect((await approve(manager, conflict.change.id)).state).toBe("conflict");
    await expect(manager.revert(conflict.change.id, crypto.randomUUID())).rejects.toMatchObject(
      unavailable,
    );
    await expect(manager.revert(crypto.randomUUID(), crypto.randomUUID())).rejects.toMatchObject({
      code: "FILE_CHANGE_NOT_FOUND",
    });

    await writeFile(`${f.root}/README.md`, "# Fixture\nHello Kairomes\n");
    const applied = await manager.request(await editInput(f));
    expect((await approve(manager, applied.change.id)).state).toBe("applied");
    // A wrong fingerprint from the panel proposes nothing.
    await expect(
      manager.revert(applied.change.id, crypto.randomUUID(), "local-ui", "0".repeat(64)),
    ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(manager.list()).toHaveLength(4);
    // Later changes evict it from the 24 retained, after which it is unknown.
    for (let index = 0; index < 24; index++)
      manager.cancel((await manager.request(await editInput(f))).change.id);
    await expect(manager.revert(applied.change.id, crypto.randomUUID())).rejects.toMatchObject({
      code: "FILE_CHANGE_NOT_FOUND",
    });
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("creating a revert never evicts the change it reverts", async () => {
  const f = await fixture();
  const manager = new FileChangeManager(f.registry, () => undefined);
  try {
    const applied = await manager.request(await editInput(f));
    expect((await approve(manager, applied.change.id)).state).toBe("applied");
    // The original is the oldest of 24 retained changes.
    for (let index = 0; index < 23; index++)
      manager.cancel((await manager.request(await editInput(f))).change.id);
    expect(manager.list()).toHaveLength(24);
    const revert = await manager.revert(applied.change.id, crypto.randomUUID());
    expect(manager.list().some((change) => change.id === applied.change.id)).toBe(true);
    // While the revert is pending, later unrelated changes do not evict the original either.
    for (let index = 0; index < 2; index++)
      manager.cancel((await manager.request(await editInput(f))).change.id);
    expect(manager.list().some((change) => change.id === applied.change.id)).toBe(true);
    const approval = manager.approvals().find((item) => item.id === revert.change.id);
    await manager.decide(revert.change.id, approval?.fingerprint ?? "", false);
    const retry = await manager.revert(applied.change.id, crypto.randomUUID());
    expect(retry.change).toMatchObject({ state: "pending", reverts_change_id: applied.change.id });
    expect(manager.list()).toHaveLength(24);
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("a revert auto-applies under a files grant and works through the MCP tool", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const original = await readFile(`${f.root}/README.md`);
    await service.enableAccess(f.workspace.id, "files", null, "owner", () => true);
    const applied = await service.changes.request(await editInput(f), "mcp");
    expect(applied.change.state).toBe("applied");
    const result = await service.call(
      "file_change_revert",
      { change_id: applied.change.id, request_id: crypto.randomUUID() },
      "mcp",
    );
    expect(result.isError).not.toBe(true);
    const revert = FileChangeResultSchema.parse(result.structuredContent);
    expect(revert.change).toMatchObject({
      state: "applied",
      reverts_change_id: applied.change.id,
    });
    expect(await readFile(`${f.root}/README.md`)).toEqual(original);
    const refused = await service.call(
      "file_change_revert",
      { change_id: applied.change.id, request_id: crypto.randomUUID() },
      "mcp",
    );
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("REVERT_CONFLICT");
  } finally {
    await service.close();
    await f.dispose();
  }
});
