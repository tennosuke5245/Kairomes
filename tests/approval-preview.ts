import { ApprovalPanel } from "../apps/extension/src/approval-panel.ts";
import {
  type ApprovalItem,
  awaitingDecision,
  isImportItem,
  splitApprovalItems,
} from "../apps/extension/src/approval-state.ts";
import { imageHeader, sha256Hex } from "../apps/extension/src/image-file.ts";
import { ImageIntake } from "../apps/extension/src/image-intake.ts";
import { ImageUploadTracker } from "../apps/extension/src/image-upload.ts";
import { ImportClient } from "../apps/extension/src/import-client.ts";
import { ImportDialog } from "../apps/extension/src/import-dialog.ts";
import { activeIndicator, needButton } from "../apps/extension/src/toolbar-state.ts";
import type { ApprovalSession } from "../packages/protocol/src/activity.ts";
import type { ArtifactImportApproval } from "../packages/protocol/src/artifact-import.ts";
import type { CommandApproval } from "../packages/protocol/src/command.ts";
import type { FileChangeApproval } from "../packages/protocol/src/file-change.ts";
import { createSyntheticImports, syntheticImport } from "./import-fixture.ts";
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
import { syntheticFigureFile, syntheticFigurePng } from "./synthetic-image.ts";

// Visual fixture only. This page has no credentials, bridge, or host execution capability.
// Query flags: ?count=1|3|10, ?study=1, ?open=queue|running|recent|command|terminal|files|
// reason|truncated, ?controls (state-change buttons). Image imports: ?imports=1 adds one in
// every state; ?open=import-awaiting|import-uploaded|import-preparing|import-pending|
// import-loading|import-mismatch|import-recent|import-applied|import-conflict|
// import-uncertain|import-denied|import-failed|import-dialog|import-dialog-empty|import-overlay|
// import-preview-required (the next approve is refused until the preview is read again).
const container = document.querySelector<HTMLElement>("#approvals");
if (!container) throw new Error("Missing preview container");
const now = Date.now();
// A real UUID, so the import dialog's create passes the same schema as the daemon's.
const fixture = { id: "0000f1f1-0000-4000-8000-00000000f1f1", name: "側欄測試專案" };
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
const open = query.get("open");
const withImports =
  !study && (query.get("imports") === "1" || open?.startsWith("import-") === true);
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
if (open === "truncated")
  for (const item of pending) if ("files" in item) item.diff_truncated = true;
const items: ApprovalItem[] = study ? pending : [...pending, ...structuredClone(history)];
const workspaces = study ? [...studyWorkspaces] : [fixture];

// Synthetic image imports: one in every state, served by the in-page stand-in daemon.
const imports = createSyntheticImports({
  workspaces: [
    {
      ...fixture,
      folders: ["", "images", "design", "design/placeholders", "assets"],
      existing: ["images/logo.png"],
    },
  ],
  changed: () => setTimeout(render, 0),
});
imports.setSnapshot(() => ({ instanceId: "fixture", sessions: [], imports: imports.list() }));
const uploads = new ImageUploadTracker();
uploads.bind("fixture");
const importClient = new ImportClient({
  fetch: async (path, init) =>
    (await imports.handle(new Request(new URL(path, location.origin), init))) ??
    Response.json({ code: "VALIDATION" }, { status: 404 }),
  uploads,
  source: () => "fixture",
});
if (withImports) {
  const base = (id: string) => ({
    id: `${id}-0000-4000-8000-0000000000aa`,
    workspace: fixture,
    now,
  });
  const png = await syntheticFigurePng(1200, 750);
  const version = await sha256Hex(png);
  const header = imageHeader(png);
  const verified = {
    mime_type: "image/png" as const,
    byte_size: png.length,
    width: header?.width ?? 1200,
    height: header?.height ?? 750,
    version,
    sha256_short: version.slice(0, 12),
  };
  const host = {
    delivery: "host_file" as const,
    source_file_id: "file-synthetic",
    source_file_name: "ChatGPT Image 合成.png",
  };
  const seeded: [ArtifactImportApproval, Uint8Array?][] = [
    [
      syntheticImport(base("1a000001"), {
        state: "awaiting_file",
        expires_at: now + 9 * 60_000 + 12_000,
      }),
    ],
    [
      syntheticImport(base("1a000002"), {
        ...host,
        state: "preparing",
        path: "assets/cover.png",
        summary: "保存剛才生成的封面圖。",
        expires_at: now + 50_000,
      }),
    ],
    [
      syntheticImport(base("1a000003"), {
        ...host,
        ...verified,
        state: "pending",
        path: "design/placeholders/hero-wide.png",
        summary: "把橫幅示意圖存成首頁的預設插圖。",
        expires_at: now + 8 * 60_000,
        fingerprint: "d".repeat(64),
      }),
      png,
    ],
    [
      syntheticImport(base("1a000004"), {
        ...host,
        ...verified,
        state: "applying",
        write_outcome: "unknown",
        path: "design/hero-2x.png",
      }),
    ],
    [
      syntheticImport(base("1a000005"), {
        ...verified,
        state: "applied",
        write_outcome: "written_verified",
        applied_at: now - 95_000,
        path: "images/team-photo.png",
        summary: "從側欄匯入的圖片",
        origin: "panel",
      }),
    ],
    [
      syntheticImport(base("1a000006"), {
        ...host,
        state: "conflict",
        error_code: "FILE_EXISTS",
        path: "images/logo.png",
        created_at: now - 400_000,
      }),
    ],
    [
      syntheticImport(base("1a000007"), {
        ...host,
        ...verified,
        state: "failed",
        write_outcome: "unknown",
        error_code: "WRITE_UNVERIFIED",
        path: "design/banner.png",
        created_at: now - 500_000,
      }),
    ],
    [
      syntheticImport(base("1a000008"), {
        state: "denied",
        denial_reason: "先不要放進 design 資料夾",
        path: "design/draft.png",
        created_at: now - 900_000,
      }),
    ],
    [
      syntheticImport(base("1a000009"), {
        ...host,
        state: "failed",
        error_code: "FILE_DOWNLOAD_FAILED",
        path: "assets/icon.webp",
        created_at: now - 1_200_000,
      }),
    ],
    [
      syntheticImport(base("1a00000a"), {
        state: "expired",
        path: "images/old.png",
        created_at: now - 1_800_000,
      }),
    ],
    [
      syntheticImport(base("1a00000b"), {
        state: "cancelled",
        path: "images/unused.jpg",
        created_at: now - 2_400_000,
      }),
    ],
  ];
  for (const [item, bytes] of seeded) await imports.seed(item, bytes);
  if (open === "import-loading") imports.holdPreviews();
  if (open === "import-preview-required") imports.forgetNextReview();
  if (open === "import-mismatch") imports.corruptPreviews();
}
let selectedWorkspace: string | null = workspaces[0]?.id ?? null;
let available = true;
const countButton = document.querySelector<HTMLButtonElement>("#approval-count");
const countNumber = document.querySelector<HTMLElement>("#approval-number");
const activeCount = document.querySelector<HTMLButtonElement>("#active-count");
const activeNumber = document.querySelector<HTMLElement>("#active-number");
const frame = document.querySelector<HTMLIFrameElement>("#workbench");
const empty = document.querySelector<HTMLElement>("#workbench-empty");
const status = document.querySelector<HTMLElement>("#approval-status");

function showNotice(message: string, tone: string) {
  const notice = document.querySelector<HTMLElement>("#panel-notice");
  const text = document.querySelector<HTMLElement>("#panel-error");
  if (!notice || !text) return;
  text.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

function opener() {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body
    ? active
    : (countButton ?? undefined);
}

const panel = new ApprovalPanel(container, {
  decide: async (session, action, reason) => {
    if (isImportItem(session)) {
      const response = await imports.decide({
        action,
        import_id: session.id,
        fingerprint: session.fingerprint,
        ...(reason ? { reason } : {}),
      });
      if (response && !response.ok) {
        const { code } = (await response.json()) as { code?: string };
        throw Object.assign(
          new Error(
            code === "IMPORT_PREVIEW_REQUIRED"
              ? "核准前須先在這裡載入並核對圖片預覽。"
              : "請求未被接受。",
          ),
          { code },
        );
      }
      render();
      return;
    }
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
  // The coordinator's notice slot, reduced to one line for the fixture.
  report: (message) => showNotice(message, "warning"),
  inform: (message) => showNotice(message, "neutral"),
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
  imports: {
    content: (item, signal) => importClient.content(item, signal),
    upload: async (item, image) => {
      await importClient.upload(item, image);
      render();
    },
    uploadStatus: (item) => uploads.status("fixture", item.id),
  },
  // Focus returns to whatever opened the dialog (the 匯入圖片 button), like sidepanel.ts.
  startImport: () => dialog.open({ returnFocus: opener() }),
  canStartImport: () => withImports,
  // The fixture has no workbench: say what would open instead.
  openFile: (item) => showNotice(`會在工作台開啟 ${item.path}`, "neutral"),
  refresh: async () => render(),
});
const dialog = new ImportDialog({
  client: {
    create: (input, signal) => importClient.create(input, signal),
    upload: (item, image, signal) => importClient.upload(item, image, signal),
    content: (item, signal) => importClient.content(item, signal),
  },
  workspaces: () => workspaces,
  defaultWorkspace: () => selectedWorkspace,
  available: () => available,
  find: (id) => imports.list().find((item) => item.id === id),
  decide: async (item, action) => {
    const response = await imports.decide({
      action,
      import_id: item.id,
      fingerprint: item.fingerprint,
    });
    if (response && !response.ok) throw new Error("請求未被接受。");
    render();
  },
  finished: (id, approved, image) => panel.openItem(id, { approved, image }),
  announce: (message) => status?.replaceChildren(document.createTextNode(message)),
});
const intake = new ImageIntake({
  target: () => {
    if (dialog.isOpen)
      return {
        offer: (file) => dialog.offer(file),
        dropLabel: "放開以使用這張圖片",
        ownZone: dialog.dropZone,
      };
    if (panel.acceptsImage)
      return { offer: (file) => panel.offerImage(file), dropLabel: "放開以提供這張圖片" };
    return withImports
      ? {
          offer: (file) => dialog.open({ file, returnFocus: opener() }),
          dropLabel: "放開以匯入到專案",
        }
      : undefined;
  },
  notify: () => {},
  unavailable: () => "配對後才能匯入圖片。",
});
document.body.append(intake.overlay);

// Mirrors the coordinator's toolbar with the same pure helpers (tests/ cannot load it here).
function render() {
  uploads.observe("fixture", imports.list());
  const all: ApprovalItem[] = [...imports.list(), ...items];
  panel.render(all, available, selectedWorkspace);
  const { pending: waiting, ongoing } = splitApprovalItems(all);
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
const clickRow = (match: (item: ApprovalItem) => boolean, waiting = true) => {
  const target = [...imports.list(), ...items].find(
    (item) => (waiting ? awaitingDecision(item) : !awaitingDecision(item)) && match(item),
  );
  container.querySelector<HTMLButtonElement>(`button.k-row[data-id="${target?.id}"]`)?.click();
};
const importInState = (state: string, unknown?: boolean) => (item: ApprovalItem) =>
  isImportItem(item) &&
  item.state === state &&
  (unknown === undefined || (item.write_outcome === "unknown") === unknown);
if (open?.startsWith("import-")) {
  const recent = [
    "import-recent",
    "import-applied",
    "import-conflict",
    "import-uncertain",
    "import-denied",
    "import-failed",
  ];
  panel.open(recent.includes(open) ? "recent" : "pending");
  if (open === "import-awaiting" || open === "import-uploaded")
    clickRow(importInState("awaiting_file"));
  if (open === "import-preparing") clickRow(importInState("preparing"));
  if (
    ["import-pending", "import-loading", "import-mismatch", "import-preview-required"].includes(
      open,
    )
  )
    clickRow(importInState("pending"));
  if (open === "import-applied") clickRow(importInState("applied"), false);
  if (open === "import-conflict") clickRow(importInState("conflict"), false);
  if (open === "import-uncertain") clickRow(importInState("failed", true), false);
  if (open === "import-failed") clickRow(importInState("failed", false), false);
  if (open === "import-denied") clickRow(importInState("denied"), false);
  // The paste path, with a synthetic file: the same offer() a trusted paste reaches.
  if (open === "import-uploaded")
    panel.offerImage(await syntheticFigureFile("image.png", 1200, 750));
  if (open === "import-dialog")
    dialog.open({ file: await syntheticFigureFile("ChatGPT Image 合成示意.png") });
  if (open === "import-dialog-empty") dialog.open();
  if (open === "import-overlay") {
    panel.close();
    intake.hint();
  }
} else if (open) {
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
