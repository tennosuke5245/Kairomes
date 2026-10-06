import { AccessPanel } from "../apps/extension/src/access-panel.ts";
import { ActiveWorkPanel } from "../apps/extension/src/active-work-panel.ts";
import { ApprovalPanel } from "../apps/extension/src/approval-panel.ts";
import { splitApprovalItems } from "../apps/extension/src/approval-state.ts";
import type { ApprovalSession, PanelSnapshot } from "../packages/protocol/src/activity.ts";
import type { CommandApproval } from "../packages/protocol/src/command.ts";
import type { FileChangeApproval } from "../packages/protocol/src/file-change.ts";
import {
  studyApprovalDecision,
  studyApprovalItems,
  studyWorkspaces,
} from "./study-fixture-data.ts";

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
    diff_available: true,
  },
];
const query = new URLSearchParams(location.search);
const study = query.get("study") === "1";
const requested = Number(query.get("count") ?? (study ? 10 : 3));
const templates = [...changes, ...commands, ...sessions];
const count = [1, 3, 10].includes(requested) ? requested : 3;
const items = study
  ? studyApprovalItems(templates, count)
  : Array.from({ length: count }, (_, index) => {
      const template = templates[index % templates.length];
      if (!template) throw new Error("Missing approval template");
      return {
        ...structuredClone(template),
        id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`,
      };
    });
const workspaces = study ? [...studyWorkspaces] : [{ id: "fixture", name: "側欄測試專案" }];
let selectedWorkspace: string | null = workspaces[0]?.id ?? null;
const countButton = document.querySelector<HTMLButtonElement>("#approval-count");
const activeCount = document.querySelector<HTMLButtonElement>("#active-count");
const activeNumber = document.querySelector<HTMLElement>("#active-number");
const activeWork = document.querySelector<HTMLElement>("#active-work");
const activeList = document.querySelector<HTMLElement>("#active-work-list");
const frame = document.querySelector<HTMLIFrameElement>("#workbench");
const showActive = (open: boolean) => {
  if (!activeWork) return;
  activeWork.hidden = !open;
  activeCount?.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("active-work-open", open);
  if (open) activeWork.querySelector<HTMLElement>("h2")?.focus();
};
const activePanel =
  study && activeList
    ? new ActiveWorkPanel(
        activeList,
        async (item) => {
          studyApprovalDecision(item, "stop");
          render();
        },
        () => {},
      )
    : undefined;
function render() {
  panel.render(items, true, selectedWorkspace);
  const { pending, ongoing } = splitApprovalItems(items);
  if (countButton) {
    countButton.hidden = !pending.length;
    countButton.textContent = `需確認 ${pending.length}`;
  }
  if (activeCount && activeNumber && activePanel) {
    activeCount.hidden = !ongoing.length;
    activeCount.setAttribute("aria-label", `執行中的工作 ${ongoing.length} 項`);
    activeNumber.textContent = String(ongoing.length);
    activePanel.render(ongoing);
    if (!ongoing.length) showActive(false);
  }
}
const panel = new ApprovalPanel(
  container,
  async (session, action) => {
    const live = items.find((item) => item.id === session.id);
    if (!live) return;
    if (study) studyApprovalDecision(live, action);
    else if ("files" in live)
      live.state = action === "approve" ? "applying" : action === "deny" ? "denied" : "cancelled";
    else if ("argv" in live)
      live.state = action === "approve" ? "running" : action === "deny" ? "denied" : "cancelled";
    else live.state = action === "approve" ? "running" : action === "deny" ? "denied" : "stopped";
    render();
    setTimeout(render, 0);
  },
  () => {},
  (open) => {
    if (study) {
      showActive(false);
      if (frame) frame.hidden = open;
    }
    if (countButton) {
      countButton.setAttribute("aria-expanded", String(open));
      if (!open) countButton.focus();
    }
  },
);
render();
if (countButton) {
  countButton.hidden = false;
  countButton.textContent = `需確認 ${items.length}`;
  countButton.onclick = () => panel.open();
}
if (activeCount && study)
  activeCount.onclick = () => {
    panel.close();
    showActive(true);
  };
document.querySelector<HTMLButtonElement>("#active-close")?.addEventListener("click", () => {
  showActive(false);
  activeCount?.focus();
});
if (study)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeWork && !activeWork.hidden) {
      showActive(false);
      activeCount?.focus();
    }
  });
if (!study && query.has("controls")) {
  const controls = document.createElement("div");
  controls.style.cssText = "position:fixed;bottom:0;right:0;z-index:1000;background:white";
  let available = true;
  for (const label of ["內容變更", "離線／恢復", "差異截斷", "請求到期"]) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = `測試：${label}`;
    control.onclick = () => {
      if (label === "離線／恢復") available = !available;
      for (const item of items) {
        if (label === "內容變更") {
          if ("files" in item) item.summary = "更新後的內容";
          else if ("argv" in item) item.argv = [...item.argv, "--changed"];
        }
        if (label === "差異截斷" && "files" in item) item.diff_truncated = true;
        if (label === "請求到期") item.expires_at = Date.now() - 1;
      }
      panel.render(items, available);
    };
    controls.append(control);
  }
  document.body.append(controls);
}
const accessContainer = document.querySelector<HTMLElement>("#access");
if (accessContainer) {
  const snapshot: PanelSnapshot = {
    instanceId: "fixture",
    sessions: study ? items.filter((item): item is ApprovalSession => "shell" in item) : sessions,
    commands: study ? items.filter((item): item is CommandApproval => "argv" in item) : commands,
    changes: study ? items.filter((item): item is FileChangeApproval => "files" in item) : changes,
    imports: [],
    workspaces,
    accessGrants: [],
  };
  const access = new AccessPanel(
    accessContainer,
    async (body) => {
      const input = body as {
        action: string;
        level?: "files" | "full";
        minutes?: number | null;
        workspace_id?: string;
      };
      const target = workspaces.find((workspace) => workspace.id === input.workspace_id);
      if (!target) throw new Error("合成授權專案不存在。");
      snapshot.accessGrants = [
        ...(snapshot.accessGrants ?? []).filter((grant) => grant.workspace_id !== target.id),
        ...(input.action === "enable"
          ? [
              {
                id: `fake-grant-${target.id}`,
                workspace_id: target.id,
                workspace_name: target.name,
                level: input.level ?? "full",
                expires_at:
                  input.minutes === null ? null : Date.now() + (input.minutes ?? 15) * 60000,
              },
            ]
          : []),
      ];
      access.render(snapshot);
    },
    () => {},
  );
  access.render(snapshot);
  access.selectWorkspace(selectedWorkspace);
  const workspaceSelector = document.querySelector<HTMLSelectElement>("#workspace-filter");
  if (workspaceSelector) {
    workspaceSelector.hidden = false;
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = study ? workspace.name : "側欄測試專案（長名稱與範圍驗收）";
      workspaceSelector.append(option);
    }
    workspaceSelector.value = selectedWorkspace ?? "";
    workspaceSelector.title = workspaceSelector.selectedOptions[0]?.textContent ?? "全部本機操作";
    workspaceSelector.onchange = () => {
      selectedWorkspace = workspaceSelector.value || null;
      workspaceSelector.title = workspaceSelector.selectedOptions[0]?.textContent ?? "全部本機操作";
      access.selectWorkspace(selectedWorkspace);
      render();
    };
  }
}
