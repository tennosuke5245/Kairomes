import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
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
