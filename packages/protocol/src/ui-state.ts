// One semantic status system for every surface (design spec §3). Pure data: no DOM, no zod,
// so Desktop, the extension and the widget can import it directly via
// "@kairomes/protocol/ui-state". Every state carries an icon and a text label as well as a
// tone; colour is never the only signal.

/** Semantic tone. `attention` means a human decision is waiting (需確認). */
export type UiTone = "attention" | "running" | "success" | "warning" | "danger" | "neutral";

/** Values accepted by `[data-tone]` in @kairomes/ui-tokens. `attention` renders as `brand`. */
export type UiDataTone = "brand" | "running" | "success" | "warning" | "danger" | "neutral";

/** Phosphor 2.1.10 component names (regular weight). `Dot` means a `.k-dot`, not an icon. */
export type UiStateIcon =
  | "ArrowsClockwise"
  | "Broadcast"
  | "Check"
  | "CircleNotch"
  | "ClockCountdown"
  | "Dot"
  | "Lightning"
  | "MinusCircle"
  | "PencilSimple"
  | "Prohibit"
  | "Question"
  | "ShieldCheck"
  | "SignIn"
  | "TerminalWindow"
  | "Tray"
  | "WarningCircle"
  | "XCircle";

export type UiStateKind =
  | "command"
  | "terminal"
  | "file_change"
  | "artifact_import"
  /** Activity entries for plain tool calls (reads, searches, MCP calls). */
  | "tool"
  | "mcp_server"
  | "mcp_auth"
  /** Access mode of a workspace: step, files, full (alias: auto). */
  | "access"
  /** Side panel ↔ local workbench connection. */
  | "connection";

export interface UiState {
  tone: UiTone;
  dataTone: UiDataTone;
  icon: UiStateIcon;
  /** Traditional Chinese label shown next to the icon. */
  label: string;
  /** True when the icon is a CircleNotch that rotates (`.k-spin`; reduced motion stops it). */
  spin: boolean;
}

type Entry = readonly [tone: UiTone, icon: UiStateIcon, label: string, spin?: boolean];

const pending: Entry = ["attention", "Tray", "需確認"];
const starting: Entry = ["running", "CircleNotch", "啟動中", true];
const working: Entry = ["running", "CircleNotch", "執行中", true];
const applying: Entry = ["running", "CircleNotch", "套用中", true];
const connecting: Entry = ["running", "Broadcast", "連線中"];
// A finished run result. It never claims the result was verified or is safe.
const completed: Entry = ["success", "Check", "已完成"];
const applied: Entry = ["success", "Check", "已套用"];
const failed: Entry = ["danger", "XCircle", "失敗"];
const timedOut: Entry = ["danger", "XCircle", "逾時"];
const conflict: Entry = ["danger", "XCircle", "版本衝突"];
const error: Entry = ["danger", "WarningCircle", "錯誤"];
const denied: Entry = ["neutral", "Prohibit", "已拒絕"];
const cancelled: Entry = ["neutral", "MinusCircle", "已取消"];
const stopped: Entry = ["neutral", "MinusCircle", "已停止"];
const expired: Entry = ["neutral", "ClockCountdown", "已到期"];
const uncertain: Entry = ["warning", "Question", "結果待確認"];
const stale: Entry = ["warning", "ArrowsClockwise", "內容可能已過時"];

/** UI-only states any kind may report: in-flight mutations, snapshots and generic results. */
const shared: Record<string, Entry> = {
  pending,
  starting,
  working,
  running: working,
  applying,
  connecting,
  completed,
  succeeded: completed,
  applied,
  failed,
  timed_out: timedOut,
  conflict,
  error,
  denied,
  cancelled,
  stopped,
  expired,
  unknown: uncertain,
  uncertain,
  stale,
};

const byKind: Record<UiStateKind, Record<string, Entry>> = {
  command: {},
  // An open terminal is not "working"; it is waiting for input. Same tone everywhere.
  terminal: {
    running: ["running", "TerminalWindow", "可接收輸入"],
    exited: ["neutral", "MinusCircle", "已結束"],
    failed: ["danger", "XCircle", "啟動失敗"],
  },
  file_change: {},
  artifact_import: {
    // The local user has to drop, paste or choose the image in the side panel.
    awaiting_file: ["attention", "Tray", "等待圖片"],
    preparing: ["running", "CircleNotch", "準備中", true],
  },
  tool: {},
  mcp_server: {
    ready: ["success", "Dot", "已連線"],
    connecting: ["running", "Dot", "連線中"],
    disconnected: ["neutral", "Dot", "尚未連線"],
    disabled: ["neutral", "Dot", "已關閉"],
    unavailable: ["danger", "WarningCircle", "啟動失敗"],
    // Derived from auth.auth_phase === "required": no switch until the user logs in.
    needs_login: ["warning", "SignIn", "需要登入"],
  },
  mcp_auth: {
    required: ["warning", "SignIn", "需要登入"],
    starting: ["running", "CircleNotch", "啟動登入中", true],
    waiting: ["running", "SignIn", "等待登入"],
    verifying: ["running", "CircleNotch", "確認登入中", true],
    authenticated: ["success", "Check", "已登入"],
    error: ["danger", "WarningCircle", "登入失敗"],
  },
  access: {
    step: ["neutral", "ShieldCheck", "逐步確認"],
    files: ["warning", "PencilSimple", "檔案自主"],
    full: ["warning", "Lightning", "全自主"],
    auto: ["warning", "Lightning", "全自主"],
  },
  connection: {
    connected: ["success", "Dot", "已連線"],
    connecting: ["running", "Dot", "連線中"],
    reconnecting: ["running", "Dot", "重新連線中"],
    offline: ["danger", "Dot", "本機工作台沒有回應"],
  },
};

const dataTones: Record<UiTone, UiDataTone> = {
  attention: "brand",
  running: "running",
  success: "success",
  warning: "warning",
  danger: "danger",
  neutral: "neutral",
};

/** Maps a semantic tone to the `[data-tone]` attribute value used by @kairomes/ui-tokens. */
export function dataToneFor(tone: UiTone): UiDataTone {
  return dataTones[tone];
}

// Kinds whose states are not work results: shared rows do not apply, and an unrecognised
// value gets a kind-specific "unconfirmed" label instead of 結果待確認.
const unconfirmed: Partial<Record<UiStateKind, Entry>> = {
  access: ["warning", "Question", "權限待確認"],
  mcp_auth: ["warning", "Question", "登入狀態待確認"],
};

const own = <T>(table: Partial<Record<string, T>>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/**
 * Tone, icon and label for a protocol or UI state. Kind-specific rows win over shared rows.
 * Anything unrecognised is reported as unconfirmed (warning): an unknown state is never
 * shown as success, and success itself is a run result (已完成), never "verified" or "safe".
 */
export function toneFor(kind: UiStateKind, state: string): UiState {
  const kindTable = own(byKind, kind) ?? {};
  const fallback = own(unconfirmed, kind);
  const entry = own(kindTable, state) ?? (fallback ? undefined : own(shared, state));
  const [tone, icon, label, spin = false] = entry ?? fallback ?? uncertain;
  return { tone, dataTone: dataTones[tone], icon, label, spin };
}

/**
 * Sprite id for a vanilla page's inline Phosphor sprite (`<use href="#ph-…">`): the kebab-case
 * component name, e.g. CircleNotch → ph-circle-notch, XCircle → ph-x-circle. A build-time
 * sprite must use the same rule; append `-fill` for the filled weight.
 */
export function iconSpriteId(icon: Exclude<UiStateIcon, "Dot">) {
  return `ph-${icon.replace(/(?<=[A-Za-z0-9])(?=[A-Z])/g, "-").toLowerCase()}`;
}

export type WorkspaceHue = 1 | 2 | 3 | 4 | 5;

/**
 * Decorative workspace hue ws-1 … ws-5 (design spec § Workspace hue): FNV-1a over the ID's
 * UTF-16 code units. The side panel, the workbench and Desktop all use this one function, so a
 * project keeps its colour on every surface; its name is always shown beside it.
 */
export function workspaceHue(workspaceId: string): WorkspaceHue {
  let hash = 0x811c9dc5;
  for (let index = 0; index < workspaceId.length; index++) {
    hash ^= workspaceId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (((hash >>> 0) % 5) + 1) as WorkspaceHue;
}

/**
 * Byte size in binary units, as every Kairomes limit is stated (25 MiB): `980 B`, `2.1 KiB`,
 * `150 KiB`, `3.1 MiB`, one decimal below 100. The side panel, the workbench and the result
 * card all use it, so one file reads the same size everywhere.
 */
export function formatBytes(bytes: number) {
  const value = Math.max(0, bytes);
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit++;
  }
  return `${scaled < 100 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}
