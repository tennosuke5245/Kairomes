import { AccessPanel } from "../apps/extension/src/access-panel.ts";
import { ApprovalPanel } from "../apps/extension/src/approval-panel.ts";
import type { ApprovalSession, PanelSnapshot } from "../packages/protocol/src/activity.ts";
import type { CommandApproval } from "../packages/protocol/src/command.ts";
import type { FileChangeApproval } from "../packages/protocol/src/file-change.ts";

// Visual fixture only. This page has no credentials, bridge, or host execution capability.
const container = document.querySelector<HTMLElement>("#approvals");
if (!container) throw new Error("Missing preview container");
const sessions: ApprovalSession[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "fixture",
    workspace_name: "側欄測試專案",
    cwd: "",
    absolute_cwd: "C:\\Kairomes-Fixture\\project",
    shell: "cmd",
    mode: "host-pty",
    state: "pending",
    created_at: Date.now(),
    expires_at: Date.now() + 300000,
    cols: 80,
    rows: 24,
    exit_code: null,
    fingerprint: "a".repeat(64),
    command: ["cmd.exe", "/d", "/q"],
  },
];
const commands: CommandApproval[] = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    request_id: crypto.randomUUID(),
    workspace_id: "fixture",
    workspace_name: "側欄測試專案",
    cwd: "",
    absolute_cwd: "C:\\Kairomes-Fixture\\project",
    executable: "C:\\Tools\\bun.exe",
    argv: ["bun.cmd", "run", "check"],
    timeout_ms: 120000,
    state: "pending",
    created_at: Date.now(),
    started_at: null,
    ended_at: null,
    expires_at: Date.now() + 300000,
    exit_code: null,
    signal: null,
    message: null,
    fingerprint: "b".repeat(64),
  },
];
const changes: FileChangeApproval[] = [
  {
    id: "00000000-0000-4000-8000-000000000003",
    request_id: crypto.randomUUID(),
    workspace_id: "fixture",
    workspace_name: "側欄測試專案",
    summary: "調整歡迎訊息並新增測試",
    state: "pending",
    created_at: Date.now(),
    applied_at: null,
    expires_at: Date.now() + 300000,
    message: null,
    files: [
      {
        operation: "edit",
        path: "src/main.ts",
        before_version: "1".repeat(64),
        after_version: "2".repeat(64),
      },
      {
        operation: "write",
        path: "tests/main.test.ts",
        before_version: null,
        after_version: "3".repeat(64),
      },
    ],
    fingerprint: "c".repeat(64),
    diff: [
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ exact replacement 1 @@",
      '-export const message = "Kairomes";',
      '+export const message = "Kairomes 喵";',
      "",
      "--- /dev/null",
      "+++ b/tests/main.test.ts",
      "@@ create file @@",
      '+test("message", () => expect(message).toContain("喵"));',
    ].join("\n"),
    diff_truncated: false,
  },
];
const items = [...changes, ...commands, ...sessions];
const panel = new ApprovalPanel(
  container,
  async (session, action) => {
    if ("files" in session)
      session.state =
        action === "approve" ? "applying" : action === "deny" ? "denied" : "cancelled";
    else if ("argv" in session)
      session.state = action === "approve" ? "running" : action === "deny" ? "denied" : "cancelled";
    else
      session.state = action === "approve" ? "running" : action === "deny" ? "denied" : "stopped";
    panel.render(items);
    setTimeout(() => panel.render(items), 0);
  },
  () => {},
);
panel.render(items);
const accessContainer = document.querySelector<HTMLElement>("#access");
if (accessContainer) {
  const snapshot: PanelSnapshot = {
    instanceId: "fixture",
    sessions,
    commands,
    changes,
    imports: [],
    workspaces: [{ id: "fixture", name: "側欄測試專案" }],
    accessGrants: [],
  };
  const access = new AccessPanel(
    accessContainer,
    async (body) => {
      const input = body as {
        action: string;
        level?: "files" | "full";
        minutes?: number | null;
      };
      snapshot.accessGrants =
        input.action === "enable"
          ? [
              {
                id: "fake-grant",
                workspace_id: "fixture",
                workspace_name: "側欄測試專案",
                level: input.level ?? "full",
                expires_at:
                  input.minutes === null ? null : Date.now() + (input.minutes ?? 15) * 60000,
              },
            ]
          : [];
      access.render(snapshot);
    },
    () => {},
  );
  access.render(snapshot);
}
