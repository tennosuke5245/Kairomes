import { expect, test } from "bun:test";
import type {
  ApprovalSession,
  ArtifactImportApproval,
  CommandApproval,
  FileChangeApproval,
} from "@kairomes/protocol";
import {
  approvalPreview,
  approvalRisk,
  approvalTitle,
  argvPreview,
  clockTime,
  countdown,
  countdownMilestone,
  cwdNote,
  diffCoversFiles,
  diffStat,
  diffStatusPill,
  formatDuration,
  importFileAction,
  importOutcomeReason,
  importRequester,
  importSourceText,
  isPanelImport,
  modelReason,
  outcomeReason,
  preparingText,
  primaryLabel,
  queueRow,
  quoteArgument,
  recentTime,
  relativeTime,
  requestFragment,
  requestMetaLabel,
  riskStrip,
  runningMeta,
  stateView,
  timeLimit,
  visibleSegments,
  workspaceHue,
} from "./approval-view.ts";

const command: CommandApproval = {
  id: "00000002-0000-4000-8000-000000000000",
  request_id: "00000002-0000-4000-8000-000000000001",
  workspace_id: "workspace-1",
  workspace_name: "Kairomes",
  cwd: "",
  absolute_cwd: "D:\\code\\kairomes",
  executable: "C:\\Users\\mei\\.bun\\bin\\bun.exe",
  argv: ["bun", "run", "check"],
  timeout_ms: 120_000,
  state: "pending",
  created_at: 1_000,
  started_at: null,
  ended_at: null,
  expires_at: 301_000,
  exit_code: null,
  signal: null,
  message: null,
  fingerprint: "b".repeat(64),
};
const terminal: ApprovalSession = {
  id: "00000003-0000-4000-8000-000000000000",
  workspace_id: "workspace-1",
  workspace_name: "Kairomes",
  cwd: "packages/app",
  absolute_cwd: "D:\\code\\kairomes\\packages\\app",
  shell: "powershell",
  mode: "host-pty",
  state: "pending",
  created_at: 1_000,
  expires_at: 301_000,
  cols: 80,
  rows: 24,
  exit_code: null,
  fingerprint: "a".repeat(64),
  command: ["powershell.exe", "-NoLogo"],
};
const change: FileChangeApproval = {
  id: "00000001-0000-4000-8000-000000000000",
  request_id: "00000001-0000-4000-8000-000000000001",
  workspace_id: "workspace-1",
  workspace_name: "Kairomes",
  summary: "把歡迎訊息改成「Kairomes 已就緒」並補上測試。",
  state: "pending",
  created_at: 1_000,
  applied_at: null,
  expires_at: 301_000,
  message: null,
  files: [
    { operation: "edit", path: "src/main.ts", before_version: null, after_version: null },
    { operation: "write", path: "tests/main.test.ts", before_version: null, after_version: null },
  ],
  fingerprint: "c".repeat(64),
  diff: [
    "--- a/src/main.ts",
    "+++ b/src/main.ts",
    "@@ exact replacement 1 @@",
    '-export const message = "Kairomes";',
    '+export const message = "Kairomes 已就緒";',
    "",
    "--- /dev/null",
    "+++ b/tests/main.test.ts",
    "@@ create file @@",
    '+import { expect, test } from "bun:test";',
    '+test("message", () => expect(1).toBe(1));',
  ].join("\n"),
  diff_truncated: false,
  diff_available: true,
};
const image: ArtifactImportApproval = {
  id: "00000004-0000-4000-8000-000000000000",
  request_id: "00000004-0000-4000-8000-000000000001",
  workspace_id: "workspace-1",
  workspace_name: "Kairomes",
  path: "assets/logo.png",
  summary: "  ",
  source_file_id: "file-1",
  source_file_name: "logo.png",
  claimed_mime_type: "image/png",
  mime_type: "image/png",
  byte_size: 2048,
  width: 64,
  height: 64,
  version: "d".repeat(64),
  state: "pending",
  created_at: 1_000,
  applied_at: null,
  expires_at: 301_000,
  message: null,
  artifact: null,
  delivery: "host_file",
  origin: "tool",
  sha256_short: "dddddddddddd",
  upload_id: null,
  write_outcome: "not_written",
  error_code: null,
  fingerprint: "d".repeat(64),
};

test("titles, primary actions and row previews describe each request kind", () => {
  expect([command, terminal, change, image].map(approvalTitle)).toEqual([
    "執行命令",
    "開啟終端機",
    "修改 2 個檔案",
    "匯入圖片",
  ]);
  expect([command, terminal, change, image].map(primaryLabel)).toEqual([
    "允許這次",
    "允許 15 分鐘",
    "套用這批",
    "匯入圖片",
  ]);
  expect(approvalPreview(command)).toBe("bun run check");
  expect(approvalPreview(terminal)).toBe("powershell · packages/app");
  expect(approvalPreview({ ...terminal, cwd: "" })).toBe("powershell · 專案根目錄");
  // The title already says how many files; the preview lists them without repeating it.
  expect(approvalPreview(change)).toBe("src/main.ts、tests/main.test.ts");
  expect(approvalPreview(image)).toBe("assets/logo.png");
});

test("argv previews quote ambiguous elements and stop after four", () => {
  expect(quoteArgument("check")).toBe("check");
  expect(quoteArgument("C:\\Tools\\bun.exe")).toBe("C:\\Tools\\bun.exe");
  expect(quoteArgument("")).toBe('""');
  expect(quoteArgument("fix bug")).toBe('"fix bug"');
  expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""');
  expect(quoteArgument("a\nb")).toBe('"a\\nb"');
  expect(quoteArgument("safe\u202eexe.txt")).toBe('"safe\\u202Eexe.txt"');
  expect(argvPreview(["git", "commit", "-m", "fix bug", "--amend"])).toBe(
    'git commit -m "fix bug" …',
  );
  expect(argvPreview(["bun", "test"])).toBe("bun test");
});

test("invisible and reordering characters become labelled escapes, tabs only in code", () => {
  expect(visibleSegments("plain")).toEqual([{ text: "plain" }]);
  expect(visibleSegments("")).toEqual([]);
  expect(visibleSegments("a\u202eb\n")).toEqual([
    { text: "a" },
    { text: "U+202E", escape: true },
    { text: "b" },
    { text: "\\n", escape: true },
  ]);
  expect(visibleSegments("\tx")).toEqual([{ text: "\\t", escape: true }, { text: "x" }]);
  expect(visibleSegments("\tx", { keepTabs: true })).toEqual([{ text: "\tx" }]);
  // A raw multi-line block keeps its line breaks, but a carriage return is still shown.
  expect(visibleSegments("a\nb\r\n", { keepNewlines: true })).toEqual([
    { text: "a\nb" },
    { text: "\\r", escape: true },
    { text: "\n" },
  ]);
  expect(visibleSegments("zero\u200bwidth")[1]).toEqual({ text: "U+200B", escape: true });
});

test("processes carry the host-privilege facts; file writes state their workspace scope", () => {
  for (const item of [command, terminal]) {
    expect(approvalRisk(item)).toEqual({ tone: "warning", icon: "Desktop", label: "主機權限" });
    const strip = riskStrip(item, true);
    expect(strip.title).toBe("主機權限");
    expect(strip.text).toContain("Windows 帳號");
    expect(strip.text).toContain("沒有隔離");
    expect(strip.facts.map((fact) => fact.label)).toEqual(["可操作工作區外", "可連網"]);
    expect(riskStrip(item, false).text).toContain("使用者帳號");
    // Never soften the boundary.
    expect(`${strip.title}${strip.text}`).not.toMatch(/沙箱|sandbox|只限此聊天/);
  }
  for (const item of [change, image]) {
    expect(approvalRisk(item)).toEqual({ tone: "neutral", icon: "Folder", label: "工作區內" });
    const strip = riskStrip(item, true);
    expect(strip.tone).toBe("neutral");
    expect(strip.title).toBe("只寫入 Kairomes 工作區");
    expect(strip.facts).toEqual([]);
  }
  expect(riskStrip(change, true).text).toBe("套用前核對檔案版本；檔案已變動就停止，不會覆寫。");
});

test("only a non-empty model summary is offered as the unverified explanation", () => {
  expect(modelReason(change)).toBe(change.summary);
  expect(modelReason(image)).toBeUndefined();
  expect(modelReason(command)).toBeUndefined();
});

test("countdowns read 剩 m:ss, turn urgent under a minute and announce three milestones", () => {
  expect(countdown(301_000, 1_000)).toEqual({ text: "剩 5:00", spoken: "剩 5 分到期" });
  expect(countdown(61_000, 1_000)).toEqual({ text: "剩 1:00", spoken: "剩 1 分到期" });
  expect(countdown(60_001, 1_000).urgency).toBeUndefined();
  expect(countdown(60_000, 1_000)).toEqual({
    text: "剩 0:59",
    urgency: "soon",
    spoken: "剩 59 秒到期",
  });
  expect(countdown(1_000, 1_000)).toEqual({ text: "已到期", urgency: "expired", spoken: "已到期" });
  expect(countdownMilestone(undefined, 30_000)).toBeUndefined();
  expect(countdownMilestone(61_000, 60_000)).toBe("剩 1 分鐘");
  expect(countdownMilestone(60_000, 59_000)).toBeUndefined();
  expect(countdownMilestone(11_000, 10_000)).toBe("剩 10 秒");
  expect(countdownMilestone(1_000, 0)).toBe("已到期");
  // A long jump (sleeping laptop) announces only the latest milestone.
  expect(countdownMilestone(120_000, -5)).toBe("已到期");
});

test("time limits, durations and the working directory note", () => {
  expect(formatDuration(120_000)).toBe("120 秒");
  expect(formatDuration(900_000)).toBe("15 分鐘");
  expect(formatDuration(150_500)).toBe("2 分 31 秒");
  expect(timeLimit(command)).toBe("只允許這一次，最多 120 秒");
  expect(timeLimit(terminal)).toBe("核准後可使用 15 分鐘，到期自動關閉");
  expect(timeLimit(change)).toBeUndefined();
  expect(cwdNote(command)).toBe("Kairomes 專案根目錄");
  expect(cwdNote(terminal)).toBe("Kairomes 專案內的 packages/app");
  expect(cwdNote(change)).toBeUndefined();
});

test("clock and relative times follow the copy rules", () => {
  const now = new Date(2026, 9, 6, 18, 45).getTime();
  expect(clockTime(new Date(2026, 9, 6, 18, 39).getTime(), now)).toBe("下午 6:39");
  expect(clockTime(new Date(2026, 9, 6, 0, 5).getTime(), now)).toBe("上午 12:05");
  expect(clockTime(new Date(2026, 9, 5, 9, 7).getTime(), now)).toBe("昨天 上午 9:07");
  expect(clockTime(new Date(2026, 9, 3, 12, 0).getTime(), now)).toBe("10月3日 下午 12:00");
  expect(relativeTime(now - 2_000, now)).toBe("剛剛");
  expect(relativeTime(now - 30_000, now)).toBe("30 秒前");
  expect(relativeTime(now - 3 * 60_000, now)).toBe("3 分鐘前");
  expect(relativeTime(new Date(2026, 9, 6, 15, 12).getTime(), now)).toBe("下午 3:12");
  expect(requestFragment(command)).toBe("00000002");
});

test("finished work shows one fixed-map reason; exit 0 is a run result, never verification", () => {
  const succeeded = { ...command, state: "succeeded" as const, exit_code: 0, ended_at: 9_000 };
  expect(stateView(succeeded).label).toBe("已完成");
  expect(outcomeReason(succeeded)).toEqual({ text: "結束碼 0" });
  expect(outcomeReason({ ...command, state: "failed", exit_code: 1 })).toEqual({
    text: "結束碼 1",
    tone: "danger",
  });
  expect(outcomeReason({ ...command, state: "timed_out" })).toEqual({
    text: "超過 120 秒，已停止",
    tone: "danger",
  });
  expect(outcomeReason({ ...change, state: "conflict" })?.text).toBe("檔案已被修改，沒有寫入");
  expect(outcomeReason({ ...command, state: "denied" })).toBeUndefined();
  // The pill already says 已到期; the reason line never repeats it.
  expect(outcomeReason({ ...command, state: "expired" })).toBeUndefined();
  expect(outcomeReason({ ...command, state: "denied", denial_reason: "請先跑單元測試" })).toEqual({
    text: "你的說明：請先跑單元測試",
  });
  // Daemon messages never reach the page.
  expect(
    outcomeReason({ ...command, state: "failed", exit_code: 2, message: "stderr: secret" }),
  ).toEqual({ text: "結束碼 2", tone: "danger" });
  expect(stateView({ ...terminal, state: "running" }).label).toBe("可接收輸入");
  expect(stateView({ ...command, state: "mystery" as never }).label).toBe("結果待確認");
});

test("running and recent rows state elapsed or finish time", () => {
  expect(runningMeta({ ...command, state: "running", started_at: 1_000 }, 66_000)).toBe(
    "已執行 1:05",
  );
  expect(runningMeta({ ...terminal, state: "running", expires_at: 61_000 }, 1_000)).toBe("剩 1:00");
  expect(runningMeta({ ...change, state: "applying" }, 1_000)).toBeUndefined();
  const now = 10 * 60_000;
  expect(recentTime({ ...command, state: "succeeded", ended_at: now - 3 * 60_000 }, now)).toBe(
    "3 分鐘前",
  );
  expect(recentTime({ ...command, state: "denied", created_at: now - 6 * 60_000 }, now)).toBe(
    "6 分鐘前提出",
  );
});

test("diff stats, section pills and the parsed-coverage check", () => {
  expect(diffStat(change)).toEqual({ additions: 3, deletions: 1 });
  expect(diffStat({ ...change, diff: "", diff_available: false })).toBeUndefined();
  expect(diffStat(command)).toBeUndefined();
  expect(diffStatusPill("deleted")).toEqual({ label: "刪除", tone: "warning" });
  expect(diffStatusPill("added").tone).toBe("neutral");
  expect(diffCoversFiles(["tests/main.test.ts", "src/main.ts"], change.files)).toBe(true);
  expect(diffCoversFiles(["src/main.ts"], change.files)).toBe(false);
  expect(diffCoversFiles(["src/main.ts", "other.ts"], change.files)).toBe(false);
});

test("workspace hues are stable and within the five tokens", () => {
  const hue = workspaceHue("00000000-0000-4000-8000-000000000020");
  expect(hue).toBe(workspaceHue("00000000-0000-4000-8000-000000000020"));
  for (const id of ["a", "b", "workspace-1", "", "專案"]) {
    expect(workspaceHue(id)).toBeGreaterThanOrEqual(1);
    expect(workspaceHue(id)).toBeLessThanOrEqual(5);
  }
});

test("an import waiting for its image says 等待圖片 (brand); receiving shows progress, not a deadline", () => {
  const waiting = {
    ...image,
    state: "awaiting_file" as const,
    version: null,
    delivery: "user_supplied" as const,
  };
  const row = queueRow(waiting, "pending", 1_000);
  expect(row.pill).toEqual({ tone: "brand", icon: "Tray", label: "等待圖片", spin: false });
  expect(row.meta.map((part) => part.kind)).toEqual(["tag", "countdown"]);
  const receiving = queueRow({ ...image, state: "preparing" }, "pending", 1_000);
  expect(receiving.pill).toMatchObject({
    tone: "running",
    icon: "CircleNotch",
    label: "準備中",
    spin: true,
  });
  expect(receiving.meta[1]).toEqual({ kind: "text", text: "正在取得圖片…" });
  expect(preparingText({ delivery: "user_supplied" })).toBe("正在接收圖片…");
  // Pending bytes read like any other decision: the write scope, then the deadline.
  expect(queueRow(image, "pending", 1_000).pill).toMatchObject({
    label: "工作區內",
    tone: "neutral",
  });
});

test("import states use artifactImportLabel; an unknown write is 結果待確認, never 匯入失敗", () => {
  const label = (patch: Partial<ArtifactImportApproval>) => stateView({ ...image, ...patch });
  expect(label({ state: "applied", write_outcome: "written_verified" })).toMatchObject({
    label: "已匯入",
    dataTone: "success",
  });
  expect(label({ state: "failed", write_outcome: "unknown" })).toMatchObject({
    label: "結果待確認",
    dataTone: "warning",
    icon: "Question",
  });
  expect(label({ state: "failed", write_outcome: "not_written" })).toMatchObject({
    label: "匯入失敗",
    dataTone: "danger",
  });
  expect(label({ state: "conflict" })).toMatchObject({
    label: "目的檔案已存在",
    dataTone: "danger",
  });
  expect(label({ state: "expired" })).toMatchObject({ label: "已過期", dataTone: "neutral" });
});

test("import outcomes are fixed sentences; the daemon's message is never shown", () => {
  const reason = (patch: Partial<ArtifactImportApproval>) =>
    importOutcomeReason({ ...image, message: "<b>raw daemon text https://x</b>", ...patch });
  expect(reason({ state: "failed", write_outcome: "unknown" })).toEqual({
    text: "無法確認是否已寫入；請先檢查目的檔案，不要重新匯入。",
    tone: "warning",
  });
  expect(reason({ state: "conflict", error_code: "PARENT_NOT_FOUND" })?.text).toBe(
    "找不到儲存資料夾，沒有寫入。",
  );
  expect(reason({ state: "conflict", error_code: "FILE_EXISTS" })?.text).toBe(
    "同名檔案已存在，沒有覆寫。",
  );
  expect(reason({ state: "failed", error_code: "FILE_DOWNLOAD_FAILED" })?.text).toBe(
    "無法從 ChatGPT 取得圖片，沒有寫入檔案。",
  );
  expect(reason({ state: "failed", error_code: "INVALID_IMAGE" })?.text).toContain(
    "無法讀取這張圖片",
  );
  expect(reason({ state: "denied", denial_reason: "先不要" })?.text).toBe("你的說明：先不要");
  expect(reason({ state: "applied", write_outcome: "written_verified" })).toBeUndefined();
  for (const state of ["failed", "conflict", "expired", "cancelled", "applying"] as const)
    expect(JSON.stringify(reason({ state }))).not.toContain("raw daemon text");
  expect(outcomeReason({ ...image, state: "expired" })).toEqual({ text: "請求已到期，沒有寫入。" });
});

test("an import's source is named only once its bytes were verified", () => {
  // Denied, cancelled or expired while waiting: no image ever arrived.
  expect(importSourceText({ delivery: "user_supplied", version: null })).toBeUndefined();
  // ChatGPT's download failed: there is no delivered image to name either.
  expect(importSourceText({ delivery: "host_file", version: null })).toBeUndefined();
  expect(importSourceText({ delivery: "host_file", version: "d".repeat(64) })).toBe(
    "ChatGPT 交付的圖片",
  );
  expect(importSourceText({ delivery: "user_supplied", version: "d".repeat(64) })).toBe(
    "你提供的圖片",
  );
});

test("only the daemon's origin makes an import the user's own, never its summary", () => {
  const lookalike = { ...image, delivery: "user_supplied" as const, summary: "從側欄匯入的圖片" };
  expect(isPanelImport(lookalike)).toBe(false);
  expect(importRequester(lookalike)).toBe("ChatGPT");
  const own = { ...lookalike, origin: "panel" as const };
  expect(isPanelImport(own)).toBe(true);
  expect(importRequester(own)).toBe("你（側欄）");
  expect(isPanelImport(command)).toBe(false);
});

test("the footer names an import's ID 匯入, matching 技術資訊; other requests say 請求", () => {
  expect(requestMetaLabel(image)).toEqual({ label: "匯入", value: image.id.slice(0, 8) });
  expect(requestMetaLabel(command)).toEqual({ label: "請求", value: "00000002" });
});

test("a finished import offers its file read-only: written, blocking, or of unknown outcome", () => {
  const at = (patch: Partial<ArtifactImportApproval>) => importFileAction({ ...image, ...patch });
  expect(at({ state: "applied", write_outcome: "written_verified" })).toEqual({
    label: "檢查目前檔案",
  });
  expect(at({ state: "conflict", error_code: "FILE_EXISTS" })).toEqual({ label: "查看既有檔案" });
  // A missing folder or a changed workspace has no file to show.
  expect(at({ state: "conflict", error_code: "PARENT_NOT_FOUND" })).toBeUndefined();
  expect(at({ state: "failed", write_outcome: "unknown" })).toEqual({ label: "檢查目的檔案" });
  for (const state of ["pending", "denied", "expired", "cancelled", "applying"] as const)
    expect(at({ state })).toBeUndefined();
  expect(at({ state: "failed", write_outcome: "not_written" })).toBeUndefined();
});
