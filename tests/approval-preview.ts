import { ApprovalPanel } from "../apps/extension/src/approval-panel.ts";
import { type ApprovalItem, splitApprovalItems } from "../apps/extension/src/approval-state.ts";
import { activeIndicator, needButton } from "../apps/extension/src/toolbar-state.ts";
import type { ApprovalSession } from "../packages/protocol/src/activity.ts";
import type { CommandApproval } from "../packages/protocol/src/command.ts";
import type { FileChangeApproval } from "../packages/protocol/src/file-change.ts";
import {
  markConnected,
  syntheticAccess,
  syntheticGrants,
  syntheticSwitcher,
} from "./panel-chrome-fixture.ts";
import {
  studyApprovalDecision,
  studyApprovalItems,
  studyWorkspaces,
} from "./study-fixture-data.ts";

// Visual fixture only. This page has no credentials, bridge, or host execution capability.
// Query flags: ?count=1|3|10, ?study=1, ?open=queue|running|recent|command|terminal|files|
// reason|truncated, ?controls (state-change buttons).
const container = document.querySelector<HTMLElement>("#approvals");
if (!container) throw new Error("Missing preview container");
const now = Date.now();
const fixture = { id: "fixture", name: "側欄測試專案" };
const sessions: ApprovalSession[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    workspace_id: fixture.id,
    workspace_name: fixture.name,
    cwd: "",
    absolute_cwd: "C:\\Kairomes-Fixture\\project",
    shell: "powershell",
    mode: "host-pty",
    state: "pending",
    created_at: now - 20_000,
    expires_at: now + 48_000,
    cols: 80,
    rows: 24,
    exit_code: null,
    fingerprint: "a".repeat(64),
    command: ["powershell.exe", "-NoLogo", "-NoProfile"],
  },
];
const commands: CommandApproval[] = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    request_id: "00000000-0000-4000-8000-000000000102",
    workspace_id: fixture.id,
    workspace_name: fixture.name,
    cwd: "",
    absolute_cwd: "C:\\Kairomes-Fixture\\project",
    executable: "C:\\Tools\\bun.exe",
    argv: ["bun.cmd", "run", "check", "--filter", "extension tests"],
    timeout_ms: 120_000,
    state: "pending",
    created_at: now - 15_000,
    started_at: null,
    ended_at: null,
    expires_at: now + 252_000,
    exit_code: null,
    signal: null,
    message: null,
    fingerprint: "b".repeat(64),
  },
];
const diff = [
  "--- a/src/main.ts",
  "+++ b/src/main.ts",
  "@@ 11 @@",
  ' import { render } from "./render";',
  " ",
  '-export const message = "Kairomes";',
  '+export const message = "Kairomes 已就緒，可以開始在 ChatGPT 讀取專案";',
  " render(message);",
  "",
  "--- /dev/null",
  "+++ b/tests/main.test.ts",
  "@@ create file @@",
  '+import { expect, test } from "bun:test";',
  '+import { message } from "../src/main";',
  "+",
  '+test("歡迎訊息包含產品名稱", () => {',
  '+\texpect(message).toContain("Kairomes");',
  "+});",
].join("\n");
const changes: FileChangeApproval[] = [
  {
    id: "00000000-0000-4000-8000-000000000003",
    request_id: "00000000-0000-4000-8000-000000000103",
    workspace_id: fixture.id,
    workspace_name: fixture.name,
    summary: "把歡迎訊息改成「Kairomes 已就緒」並補上測試。",
    state: "pending",
    created_at: now - 10_000,
    applied_at: null,
    expires_at: now + 580_000,
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
    diff,
    diff_truncated: false,
    diff_available: true,
  },
];
const command = commands[0] as CommandApproval;
// Work that already ran or finished, for the 執行中 and 最近 tabs (outside study mode).
const history: ApprovalItem[] = [
  {
    ...structuredClone(command),
    id: "00000011-0000-4000-8000-000000000011",
    argv: ["bun.cmd", "test", "--watch"],
    state: "running",
    started_at: now - 65_000,
    expires_at: now + 55_000,
    fingerprint: "e".repeat(64),
  },
  {
    ...structuredClone(command),
    id: "00000012-0000-4000-8000-000000000012",
    argv: ["bun.cmd", "test"],
    state: "succeeded",
    exit_code: 0,
    started_at: now - 200_000,
    ended_at: now - 180_000,
    fingerprint: "f".repeat(64),
  },
  {
    ...structuredClone(command),
    id: "00000013-0000-4000-8000-000000000013",
    argv: ["bun.cmd", "run", "lint"],
    state: "failed",
    exit_code: 1,
    started_at: now - 600_000,
    ended_at: now - 590_000,
    fingerprint: "1".repeat(64),
  },
  {
    ...structuredClone(changes[0] as FileChangeApproval),
    id: "00000014-0000-4000-8000-000000000014",
    state: "denied",
    created_at: now - 720_000,
    denial_reason: "先跑單元測試，不要改設定檔",
    diff: "",
    diff_available: false,
    fingerprint: "2".repeat(64),
  },
  {
    ...structuredClone(sessions[0] as ApprovalSession),
    id: "00000015-0000-4000-8000-000000000015",
    state: "expired",
    created_at: now - 1_500_000,
    fingerprint: "3".repeat(64),
  },
];
const query = new URLSearchParams(location.search);
const study = query.get("study") === "1";
const requested = Number(query.get("count") ?? (study ? 10 : 3));
const templates: ApprovalItem[] = [...sessions, ...commands, ...changes];
const count = [1, 3, 10].includes(requested) ? requested : 3;
const pending: ApprovalItem[] = study
  ? studyApprovalItems(templates, count)
  : Array.from({ length: count }, (_, index) => {
      const template = count === 1 ? command : templates[index % templates.length];
      if (!template) throw new Error("Missing approval template");
      const id = `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`;
      return {
        ...structuredClone(template),
        ...("request_id" in template ? { request_id: id } : {}),
        id,
        expires_at: template.expires_at + Math.floor(index / templates.length) * 60_000,
      };
    });
const open = query.get("open");
if (open === "truncated")
  for (const item of pending) if ("files" in item) item.diff_truncated = true;
const items: ApprovalItem[] = study ? pending : [...pending, ...structuredClone(history)];
const workspaces = study ? [...studyWorkspaces] : [fixture];
let selectedWorkspace: string | null = workspaces[0]?.id ?? null;
let available = true;
const countButton = document.querySelector<HTMLButtonElement>("#approval-count");
const countNumber = document.querySelector<HTMLElement>("#approval-number");
const activeCount = document.querySelector<HTMLButtonElement>("#active-count");
const activeNumber = document.querySelector<HTMLElement>("#active-number");
const frame = document.querySelector<HTMLIFrameElement>("#workbench");
const empty = document.querySelector<HTMLElement>("#workbench-empty");
const status = document.querySelector<HTMLElement>("#approval-status");

const panel = new ApprovalPanel(container, {
  decide: async (session, action, reason) => {
    const live = items.find((item) => item.id === session.id);
    if (!live) return;
    if (study) studyApprovalDecision(live, action);
    else if (action === "deny") {
      live.state = "denied";
      if (reason) live.denial_reason = reason;
    } else if (action === "stop") live.state = "shell" in live ? "stopped" : "cancelled";
    else if ("files" in live) {
      live.state = "applied";
      live.applied_at = Date.now();
      live.diff = "";
      live.diff_available = false;
    } else if ("argv" in live) {
      live.state = "running";
      live.started_at = Date.now();
    } else live.state = "running";
    render();
    setTimeout(render, 0);
  },
  report: () => {},
  change: (isOpen, tab) => {
    if (frame) frame.hidden = true;
    // The fixture has no workbench page: closing the queue shows the empty body state.
    if (empty) empty.hidden = isOpen;
    countButton?.setAttribute("aria-pressed", String(isOpen && tab !== "running"));
    activeCount?.setAttribute("aria-pressed", String(isOpen && tab === "running"));
    if (!isOpen)
      (tab === "running" && activeCount && !activeCount.hidden
        ? activeCount
        : countButton
      )?.focus();
  },
  announce: (message) => status?.replaceChildren(document.createTextNode(message)),
});

// Mirrors the coordinator's toolbar with the same pure helpers (tests/ cannot load it here).
function render() {
  panel.render(items, available, selectedWorkspace);
  const { pending: waiting, ongoing } = splitApprovalItems(items);
  if (countButton && countNumber) {
    const need = needButton(waiting.length);
    countButton.hidden = false;
    countButton.dataset.count = need.count;
    countButton.setAttribute("aria-label", need.ariaLabel);
    countNumber.hidden = !need.badge;
    countNumber.textContent = need.badge;
  }
  if (activeCount && activeNumber) {
    const active = activeIndicator(ongoing.length);
    activeCount.hidden = active.hidden;
    activeCount.setAttribute("aria-label", active.ariaLabel);
    activeCount.title = active.ariaLabel;
    activeNumber.textContent = active.badge;
  }
}
render();
if (countButton)
  countButton.onclick = () =>
    panel.isOpen && panel.tab !== "pending" ? panel.open("pending") : panel.toggle("pending");
if (activeCount) activeCount.onclick = () => panel.toggle("running");
if (empty) empty.hidden = panel.isOpen;

// Opening a view for screenshots only navigates; no decision is ever made programmatically.
const clickRow = (match: (item: ApprovalItem) => boolean) => {
  const target = items.find((item) => item.state === "pending" && match(item));
  container.querySelector<HTMLButtonElement>(`button.k-row[data-id="${target?.id}"]`)?.click();
};
if (open) {
  panel.open(open === "running" || open === "recent" ? open : "pending");
  if (open === "command") clickRow((item) => "argv" in item);
  if (open === "terminal") clickRow((item) => "shell" in item);
  if (open === "files" || open === "truncated" || open === "reason")
    clickRow((item) => "files" in item);
  if (open === "reason")
    setTimeout(() => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "拒絕並說明原因…")
        ?.click();
      const input = container.querySelector<HTMLTextAreaElement>("textarea");
      if (input) {
        input.value = "先跑單元測試，不要改設定檔";
        input.dispatchEvent(new Event("input"));
      }
    }, 800);
}

if (!study && query.has("controls")) {
  const controls = document.createElement("div");
  controls.style.cssText = "position:fixed;bottom:0;right:0;z-index:1000;background:white";
  for (const label of ["內容變更", "離線／恢復", "差異截斷", "請求到期"]) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = `測試：${label}`;
    control.onclick = () => {
      if (label === "離線／恢復") available = !available;
      for (const item of items) {
        if (item.state !== "pending") continue;
        if (label === "內容變更") {
          if ("files" in item) item.summary = "更新後的內容";
          else if ("argv" in item) item.argv = [...item.argv, "--changed"];
        }
        if (label === "差異截斷" && "files" in item) item.diff_truncated = true;
        if (label === "請求到期") item.expires_at = Date.now() - 1;
      }
      render();
    };
    controls.append(control);
  }
  document.body.append(controls);
}
markConnected();
const fixtureWorkspaces = study
  ? workspaces
  : workspaces.map((workspace) => ({ ...workspace, name: "側欄測試專案（長名稱與範圍驗收）" }));
const access = syntheticAccess(
  {
    instanceId: "fixture",
    sessions: items.filter((item): item is ApprovalSession => "shell" in item),
    commands: items.filter((item): item is CommandApproval => "argv" in item),
    changes: items.filter((item): item is FileChangeApproval => "files" in item),
    imports: [],
    workspaces,
    accessGrants: syntheticGrants(workspaces, query),
  },
  selectedWorkspace,
);
syntheticSwitcher(fixtureWorkspaces, selectedWorkspace, (id) => {
  selectedWorkspace = id;
  access?.selectWorkspace(selectedWorkspace);
  render();
});
