import {
  type ArtifactImportApproval,
  artifactImportDisplayState,
  artifactImportLabel,
} from "@kairomes/protocol";
import { parseUnifiedDiff } from "@kairomes/protocol/diff-lines";
import { toneFor, type UiDataTone, type UiStateKind } from "@kairomes/protocol/ui-state";
import { formatRemaining, spokenRemaining } from "./access-state.ts";
import type { ApprovalBlock, ApprovalItem } from "./approval-state.ts";
import type { PanelIcon } from "./icons.ts";
import { importErrorField, importErrorText } from "./image-file.ts";

// Pure presentation helpers for the trusted approval page: no DOM. Every string returned here
// is rendered through textContent; model-provided values are never parsed as markup.

export type ApprovalKind = Extract<
  UiStateKind,
  "artifact_import" | "file_change" | "command" | "terminal"
>;

export function approvalKind(item: ApprovalItem): ApprovalKind {
  if ("source_file_id" in item) return "artifact_import";
  if ("files" in item) return "file_change";
  if ("argv" in item) return "command";
  return "terminal";
}

const kindIcons: Record<ApprovalKind, PanelIcon> = {
  artifact_import: "Image",
  file_change: "PencilSimple",
  command: "Terminal",
  terminal: "TerminalWindow",
};

export const approvalKindIcon = (item: ApprovalItem) => kindIcons[approvalKind(item)];

export function approvalTitle(item: ApprovalItem) {
  if ("source_file_id" in item) return "匯入圖片";
  if ("files" in item) return `修改 ${item.files.length} 個檔案`;
  return "argv" in item ? "執行命令" : "開啟終端機";
}

/** How long an approved terminal stays open (apps/daemon/src/terminal.ts grantMs). */
export const TERMINAL_GRANT_MINUTES = 15;

export function primaryLabel(item: ApprovalItem) {
  if ("source_file_id" in item) return "匯入圖片";
  if ("files" in item) return "套用這批";
  return "argv" in item ? "允許這次" : `允許 ${TERMINAL_GRANT_MINUTES} 分鐘`;
}

// Characters that render as nothing, move the caret or reorder text (Trojan Source). A
// reviewer must see them, so they are shown as labelled escapes instead of being rendered.
const invisible = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const invisibleGlobal = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const named: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };

export function escapeLabel(character: string) {
  return (
    named[character] ??
    `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`
  );
}

export type VisibleSegment = { text: string; escape?: false } | { text: string; escape: true };

/**
 * Splits reviewed text into plain runs and escapes for invisible or reordering characters.
 * `keepTabs` leaves tab indentation alone in code and `keepNewlines` keeps line breaks in a
 * multi-line block; everything else is always escaped.
 */
export function visibleSegments(
  text: string,
  options: { keepTabs?: boolean; keepNewlines?: boolean } = {},
) {
  const segments: VisibleSegment[] = [];
  let plain = "";
  for (const character of text) {
    const kept =
      (options.keepTabs && character === "\t") || (options.keepNewlines && character === "\n");
    if (invisible.test(character) && !kept) {
      if (plain) segments.push({ text: plain });
      plain = "";
      segments.push({ text: escapeLabel(character), escape: true });
    } else plain += character;
  }
  if (plain) segments.push({ text: plain });
  return segments;
}

const plainArgument = /^[\p{L}\p{M}\p{N}_\-.,/\\:=@%+~^]+$/u;

/** A code-style escape inside a quoted single-line preview: `\n`, `\u202E`. */
function inlineEscape(character: string) {
  const code = character.codePointAt(0) ?? 0;
  const hex = code.toString(16).toUpperCase();
  return named[character] ?? (code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`);
}

/** One argv element as a reader would type it: bare when unambiguous, otherwise quoted. */
export function quoteArgument(value: string) {
  if (plainArgument.test(value)) return value;
  return `"${value.replace(/"/g, '\\"').replace(invisibleGlobal, inlineEscape)}"`;
}

/** The first `limit` argv elements, quoted where needed, then `…` when more follow. */
export function argvPreview(argv: readonly string[], limit = 4) {
  const shown = argv.slice(0, limit).map(quoteArgument).join(" ");
  return argv.length > limit ? `${shown} …` : shown;
}

/** A single-line preview for queue rows. The detail always shows the complete value. */
export function approvalPreview(item: ApprovalItem) {
  if ("source_file_id" in item) return oneLine(item.path);
  if ("files" in item) return item.files.map((file) => oneLine(file.path)).join("、");
  if ("argv" in item) return argvPreview(item.argv);
  return `${item.shell} · ${item.cwd ? oneLine(item.cwd) : "專案根目錄"}`;
}

function oneLine(value: string) {
  return value.replace(invisibleGlobal, inlineEscape);
}

export type ApprovalRisk = { tone: UiDataTone; icon: PanelIcon; label: string };

/** The row's trailing pill: host privilege for processes, workspace scope for file writes. */
export function approvalRisk(item: ApprovalItem): ApprovalRisk {
  const kind = approvalKind(item);
  return kind === "command" || kind === "terminal"
    ? { tone: "warning", icon: "Desktop", label: "主機權限" }
    : { tone: "neutral", icon: "Folder", label: "工作區內" };
}

export interface RiskStrip {
  tone: "warning" | "neutral";
  icon: PanelIcon;
  fill: boolean;
  title: string;
  text: string;
  facts: { icon: PanelIcon; label: string }[];
}

/**
 * The first block of a decision view. Commands and shells always state host privilege, reach
 * outside the workspace and network access; nothing here claims isolation or a sandbox.
 */
export function riskStrip(item: ApprovalItem, windows: boolean): RiskStrip {
  const account = windows ? "Windows 帳號" : "使用者帳號";
  const kind = approvalKind(item);
  if (kind === "command" || kind === "terminal")
    return {
      tone: "warning",
      icon: "ShieldWarning",
      fill: true,
      title: "主機權限",
      text:
        kind === "command"
          ? `以你的${account}執行，沒有隔離。`
          : `開啟可輸入任何命令的 shell，以你的${account}執行，沒有隔離。`,
      facts: [
        { icon: "ArrowSquareOut", label: "可操作工作區外" },
        { icon: "Globe", label: "可連網" },
      ],
    };
  return {
    tone: "neutral",
    icon: "ShieldCheck",
    fill: false,
    title: `只寫入 ${item.workspace_name} 工作區`,
    text:
      kind === "file_change"
        ? "套用前核對檔案版本；檔案已變動就停止，不會覆寫。"
        : "只建立新檔，不會覆寫既有檔案。",
    facts: [],
  };
}

/** Model-provided explanation, if the request type carries one (shown as unverified). */
export function modelReason(item: ApprovalItem) {
  return "summary" in item && item.summary.trim() ? item.summary : undefined;
}

/** Below this, a pending request's countdown takes the warning style. */
export const APPROVAL_SOON_MS = 60_000;

export interface Countdown {
  text: string;
  urgency?: "soon" | "expired";
  /** Accessible name; the countdown itself is not announced every second. */
  spoken: string;
}

export function countdown(expiresAt: number, now: number): Countdown {
  const remaining = expiresAt - now;
  if (remaining <= 0) return { text: "已到期", urgency: "expired", spoken: "已到期" };
  return {
    text: `剩 ${formatRemaining(remaining)}`,
    // Urgent exactly when the shown time drops below 1:00 (the text rounds up).
    ...(Math.ceil(remaining / 1000) * 1000 < APPROVAL_SOON_MS ? { urgency: "soon" as const } : {}),
    spoken: `剩 ${spokenRemaining(remaining)}到期`,
  };
}

const milestones = [
  [APPROVAL_SOON_MS, "剩 1 分鐘"],
  [10_000, "剩 10 秒"],
  [0, "已到期"],
] as const;

/**
 * The one message to announce when the open request's countdown crosses 60 s, 10 s or
 * expiry. Opening a request (no previous reading) never announces.
 */
export function countdownMilestone(previous: number | undefined, current: number) {
  if (previous === undefined) return undefined;
  let message: string | undefined;
  for (const [threshold, text] of milestones)
    if (previous > threshold && current <= threshold) message = text;
  return message;
}

/** `120 秒`, `15 分鐘`, `2 分 30 秒`. */
export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds <= 120) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分鐘`;
}

/** The decision's scope in time, shown as the last fact of a command or terminal. */
export function timeLimit(item: ApprovalItem) {
  if ("argv" in item) return `只允許這一次，最多 ${formatDuration(item.timeout_ms)}`;
  if ("shell" in item) return `核准後可使用 ${TERMINAL_GRANT_MINUTES} 分鐘，到期自動關閉`;
  return undefined;
}

/** Where a process starts, relative to the project (the codebox shows the exact path). */
export function cwdNote(item: ApprovalItem) {
  if (!("argv" in item) && !("shell" in item)) return undefined;
  return item.cwd
    ? `${item.workspace_name} 專案內的 ${oneLine(item.cwd)}`
    : `${item.workspace_name} 專案根目錄`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** `下午 6:39`; `昨天 下午 6:39`; `10月3日 下午 6:39` (local time). */
export function clockTime(at: number, now: number) {
  const date = new Date(at);
  const hours = date.getHours();
  const time = `${hours < 12 ? "上午" : "下午"} ${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (sameDay(date, today)) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** `剛剛`, `30 秒前`, `2 分鐘前`, then a clock time. */
export function relativeTime(at: number, now: number) {
  const elapsed = Math.max(0, now - at);
  if (elapsed < 10_000) return "剛剛";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)} 秒前`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分鐘前`;
  return clockTime(at, now);
}

/** First eight characters of the request id, for the detail's technical row only. */
export const requestFragment = (item: Pick<ApprovalItem, "id">) => item.id.slice(0, 8);

/**
 * The short ID in a detail's footer, named after the ID it is: an image import shows its 匯入
 * ID (the same one 技術資訊 lists in full), everything else its 請求.
 */
export function requestMetaLabel(item: ApprovalItem) {
  return { label: "source_file_id" in item ? "匯入" : "請求", value: requestFragment(item) };
}

/**
 * State pill for running and finished work (never 已驗證: exit 0 is a run result). An image
 * import takes tone and icon from toneFor and its label from artifactImportLabel, so a failed
 * write with an unknown outcome reads 結果待確認, never 匯入失敗.
 */
export function stateView(item: ApprovalItem) {
  if (!("source_file_id" in item)) return toneFor(approvalKind(item), item.state);
  return {
    ...toneFor("artifact_import", artifactImportDisplayState(item)),
    label: artifactImportLabel(item),
  };
}

/** `正在從 ChatGPT 取得圖片…` while the daemon downloads; `正在接收圖片…` for the user's upload. */
export function preparingText(item: Pick<ArtifactImportApproval, "delivery">) {
  return item.delivery === "host_file" ? "正在從 ChatGPT 取得圖片…" : "正在接收圖片…";
}

/**
 * Where the verified image came from, or undefined when no bytes were ever verified (an import
 * denied, cancelled or expired while waiting, or one whose download failed): then there is no
 * image to name, whatever the request said it would deliver.
 */
export function importSourceText(item: Pick<ArtifactImportApproval, "delivery" | "version">) {
  if (item.version === null) return undefined;
  return item.delivery === "host_file" ? "ChatGPT 交付的圖片" : "你提供的圖片";
}

/**
 * Who asked for the import, from the daemon's own record (never from the summary text): the
 * user's 匯入圖片 in this panel, or a tool request such as ChatGPT's.
 */
export function importRequester(item: Pick<ArtifactImportApproval, "origin">) {
  return item.origin === "panel" ? "你（側欄）" : "ChatGPT";
}

/**
 * The file a finished import points at, opened read-only in the workbench: the written file
 * (檢查目前檔案), the file that blocked it (查看既有檔案, never the pending image), or the target
 * of a write whose result is unknown. Undefined when there is no file worth opening.
 */
export function importFileAction(item: ArtifactImportApproval) {
  switch (artifactImportDisplayState(item)) {
    case "applied":
      return item.write_outcome === "written_verified" ? { label: "檢查目前檔案" } : undefined;
    case "conflict":
      return item.error_code === "FILE_EXISTS" || !item.error_code
        ? { label: "查看既有檔案" }
        : undefined;
    case "uncertain":
      return { label: "檢查目的檔案" };
    default:
      return undefined;
  }
}

/** True only for an import the local user opened in the side panel (daemon-recorded origin). */
export function isPanelImport(item: ApprovalItem) {
  return "source_file_id" in item && item.origin === "panel";
}

const sourceFailures = new Set([
  "FILE_DOWNLOAD_FAILED",
  "FILE_DOWNLOAD_TIMEOUT",
  "FILE_REDIRECT_BLOCKED",
  "UNSAFE_FILE_HOST",
  "IMPORT_SOURCE_REJECTED",
]);

/** One fixed reason line for a finished image import; the daemon message is never shown. */
export function importOutcomeReason(
  item: ArtifactImportApproval,
): { text: string; tone?: UiDataTone } | undefined {
  const code = item.error_code ?? "";
  switch (artifactImportDisplayState(item)) {
    case "uncertain":
      return { text: "無法確認是否已寫入；請先檢查目的檔案，不要重新匯入。", tone: "warning" };
    case "conflict":
      return {
        text:
          code === "PARENT_NOT_FOUND"
            ? "找不到儲存資料夾，沒有寫入。"
            : code === "FILE_EXISTS" || !code
              ? "同名檔案已存在，沒有覆寫。"
              : "儲存位置已變更，沒有寫入。",
        tone: "danger",
      };
    case "failed":
      return {
        text: sourceFailures.has(code)
          ? "無法從 ChatGPT 取得圖片，沒有寫入檔案。"
          : importErrorField(code) === "image"
            ? `${importErrorText(code)}沒有寫入檔案。`
            : "匯入失敗，沒有寫入檔案。",
        tone: "danger",
      };
    case "denied":
      return item.denial_reason ? { text: `你的說明：${item.denial_reason}` } : undefined;
    case "expired":
      return { text: "請求已到期，沒有寫入。" };
    case "cancelled":
      return { text: "已取消，沒有寫入。" };
    case "applying":
      return { text: "正在寫入圖片…" };
    default:
      return undefined;
  }
}

/** When finished work ended, for sorting 最近 and its relative time. */
export function finishedAt(item: ApprovalItem) {
  if ("ended_at" in item && item.ended_at !== null) return { at: item.ended_at, ended: true };
  if ("applied_at" in item && item.applied_at !== null) return { at: item.applied_at, ended: true };
  return { at: item.created_at, ended: false };
}

/** `3 分鐘前` when the end time is known; otherwise when it was requested. */
export function recentTime(item: ApprovalItem, now: number) {
  const { at, ended } = finishedAt(item);
  return ended ? relativeTime(at, now) : `${relativeTime(at, now)}提出`;
}

/** Meta for running work: elapsed time for commands, time left for an open shell. */
export function runningMeta(item: ApprovalItem, now: number) {
  if ("argv" in item && (item.state === "running" || item.state === "starting"))
    return `已執行 ${formatRemaining(now - (item.started_at ?? item.created_at))}`;
  if ("shell" in item && item.state === "running")
    return `剩 ${formatRemaining(item.expires_at - now)}`;
  return undefined;
}

/**
 * One fixed-map reason line for finished work. Daemon messages, stderr and remote text are
 * never shown. A user's own denial reason is shown back to them.
 */
export function outcomeReason(item: ApprovalItem): { text: string; tone?: UiDataTone } | undefined {
  if ("source_file_id" in item) return importOutcomeReason(item);
  if (item.state === "denied")
    return item.denial_reason ? { text: `你的說明：${item.denial_reason}` } : undefined;
  if ("argv" in item) {
    if (item.state === "succeeded") return { text: `結束碼 ${item.exit_code ?? 0}` };
    if (item.state === "failed")
      return {
        text: item.exit_code === null ? "沒有正常結束" : `結束碼 ${item.exit_code}`,
        tone: "danger",
      };
    if (item.state === "timed_out")
      return { text: `超過 ${formatDuration(item.timeout_ms)}，已停止`, tone: "danger" };
  }
  if ("shell" in item && item.state === "exited" && item.exit_code !== null)
    return { text: `結束碼 ${item.exit_code}` };
  if ("files" in item && item.state === "conflict")
    return { text: "檔案已被修改，沒有寫入", tone: "danger" };
  return undefined;
}

/** `+N −M` for a file batch whose review diff is available. */
export function diffStat(item: ApprovalItem) {
  if (!("files" in item) || !item.diff_available) return undefined;
  const parsed = parseUnifiedDiff(item.diff, { truncated: item.diff_truncated });
  return { additions: parsed.additions, deletions: parsed.deletions };
}

const operationLabels = { edit: "修改", write: "寫入", delete: "刪除" } as const;

export const fileOperationLabel = (operation: keyof typeof operationLabels) =>
  operationLabels[operation];

/** Kind pill for a diff section: 刪除 is the only warning; the rest stay neutral. */
export function diffStatusPill(status: "modified" | "added" | "deleted" | "renamed"): {
  label: string;
  tone: UiDataTone;
} {
  if (status === "added") return { label: "新檔案", tone: "neutral" };
  if (status === "deleted") return { label: "刪除", tone: "warning" };
  if (status === "renamed") return { label: "重新命名", tone: "neutral" };
  return { label: "修改", tone: "neutral" };
}

/**
 * True when every reviewed file has exactly one parsed section and nothing else appeared.
 * Otherwise the page falls back to the raw diff text, which is what the fingerprint covers.
 */
export function diffCoversFiles(
  parsedPaths: readonly string[],
  files: readonly { path: string }[],
) {
  if (parsedPaths.length !== files.length) return false;
  const expected = files.map((file) => file.path).sort();
  return [...parsedPaths].sort().every((path, index) => path === expected[index]);
}

/** Decorative workspace hue 1–5 (spec §2.2); the name is always shown beside it. */
export function workspaceHue(workspaceId: string) {
  let hash = 0;
  for (const character of workspaceId) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return (hash % 5) + 1;
}

/** The host platform wording for the risk strip. */
export function isWindowsHost(userAgent: string) {
  return /Windows/i.test(userAgent);
}

export type DecisionBlock = ApprovalBlock;

export interface DecisionNotice {
  text: string;
  tone: UiDataTone;
  icon: PanelIcon;
  action?: { kind: "rereview" | "back"; label: string };
}

/**
 * The action bar's one-line reason why a decision is blocked. Offline and unconfirmed results
 * are already stated once in the panel's notice slot (with 查詢狀態), so they add nothing here.
 */
export function decisionNotice(block: DecisionBlock | undefined): DecisionNotice | undefined {
  switch (block) {
    case "gone":
      return {
        text: "這個請求已結束。",
        tone: "neutral",
        icon: "Info",
        action: { kind: "back", label: "返回列表" },
      };
    case "expired":
      return {
        text: "這個請求已到期。",
        tone: "neutral",
        icon: "ClockCountdown",
        action: { kind: "back", label: "返回列表" },
      };
    case "changed":
      return {
        text: "內容已變更，請重新審閱。",
        tone: "warning",
        icon: "ArrowsClockwise",
        action: { kind: "rereview", label: "重新審閱" },
      };
    case "incomplete":
      return { text: "差異太大，無法完整顯示，因此不能套用。", tone: "warning", icon: "Warning" };
    default:
      return undefined;
  }
}

export type ApprovalTab = "pending" | "running" | "recent";

export type RowMeta =
  | { kind: "tag"; text: string; hue: number }
  | { kind: "countdown"; text: string; urgency?: "soon" | "expired"; spoken: string }
  | { kind: "text"; text: string }
  | { kind: "stat"; additions: number; deletions: number };

export interface RowView {
  icon: PanelIcon;
  title: string;
  pill: { tone: UiDataTone; icon: PanelIcon; label: string; spin: boolean };
  preview: string;
  meta: RowMeta[];
  reason?: { text: string; tone?: UiDataTone };
}

/**
 * One queue row. 需確認 rows lead with the risk pill and a live countdown; 執行中 and 最近 rows
 * show the state instead. The request id never appears in a row (it is in the detail).
 */
export function queueRow(
  item: ApprovalItem,
  tab: ApprovalTab,
  now: number,
  stat?: { additions: number; deletions: number },
): RowView {
  const tag: RowMeta = {
    kind: "tag",
    text: item.workspace_name,
    hue: workspaceHue(item.workspace_id),
  };
  const base = {
    icon: approvalKindIcon(item),
    title: approvalTitle(item),
    preview: approvalPreview(item),
  };
  if (tab === "pending") {
    const remaining = countdown(item.expires_at, now);
    // An image import still waiting for its image says so: 等待圖片 needs the user.
    if ("source_file_id" in item && item.state !== "pending") {
      const state = stateView(item);
      return {
        ...base,
        pill: {
          tone: state.dataTone,
          icon: state.icon as PanelIcon,
          label: state.label,
          spin: state.spin,
        },
        meta: [
          tag,
          item.state === "preparing"
            ? {
                kind: "text",
                text: item.delivery === "host_file" ? "正在取得圖片…" : "正在接收圖片…",
              }
            : { kind: "countdown", ...remaining },
        ],
      };
    }
    const risk = approvalRisk(item);
    return {
      ...base,
      pill: { ...risk, spin: false },
      meta: [
        tag,
        { kind: "countdown", ...remaining },
        ...(stat && (stat.additions || stat.deletions) ? [{ kind: "stat" as const, ...stat }] : []),
      ],
    };
  }
  const state = stateView(item);
  const pill = {
    tone: state.dataTone,
    icon: (state.icon === "Dot" ? "Question" : state.icon) as PanelIcon,
    label: state.label,
    spin: state.spin,
  };
  if (tab === "running") {
    const meta = runningMeta(item, now);
    return { ...base, pill, meta: [tag, ...(meta ? [{ kind: "text" as const, text: meta }] : [])] };
  }
  const reason = outcomeReason(item);
  return {
    ...base,
    pill,
    meta: [tag, { kind: "text", text: recentTime(item, now) }],
    ...(reason ? { reason } : {}),
  };
}

/** 執行中 newest first; 最近 by when the work finished, newest first. */
export function sortForTab<T extends ApprovalItem>(items: readonly T[], tab: "running" | "recent") {
  const key = (item: T) => (tab === "running" ? item.created_at : finishedAt(item).at);
  return [...items].sort((a, b) => key(b) - key(a));
}
