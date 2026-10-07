/**
 * Pure display rules for 從 Codex 接續 (spec §5.1 Handoff, A14): the three-step header, the
 * source rows, the coverage line and why 複製接續內容 is still unavailable. The flow component
 * keeps every request guard; this module only decides what the page says.
 */
import type {
  HandoffBaseline,
  HandoffCoverage,
  HandoffFields,
  HandoffPreview,
} from "../../../packages/protocol/src/handoff.ts";
import {
  HANDOFF_LIMITS,
  handoffCoverageTruncated,
} from "../../../packages/protocol/src/handoff.ts";
import type { PillIcon, RowTone } from "./checks.ts";
import { formatRelative } from "./format.ts";

/** 選擇來源 → 整理內容 → 預覽並複製. */
export type HandoffStage = "source" | "brief" | "preview";
export type HandoffStepState = "done" | "current" | "todo";
export type HandoffStep = { label: string; state: HandoffStepState };

const STAGES: readonly HandoffStage[] = ["source", "brief", "preview"];
export const HANDOFF_STEP_LABELS: Record<HandoffStage, string> = {
  source: "選擇來源",
  brief: "整理內容",
  preview: "預覽並複製",
};

/** The page heading: what is happening and to which project, said once. */
export function handoffTitle(workspaceName: string) {
  return `從 Codex 接續 · ${workspaceName}`;
}

/** Steps before the current one are done; after a copy the last step is done too. */
export function handoffSteps(stage: HandoffStage, copied: boolean): HandoffStep[] {
  const current = STAGES.indexOf(stage);
  return STAGES.map((step, index) => ({
    label: HANDOFF_STEP_LABELS[step],
    state:
      index < current || (copied && index === current)
        ? "done"
        : index === current
          ? "current"
          : "todo",
  }));
}

/** Screen-reader heading for a step, so moving forward announces where focus landed. */
export function handoffStepHeading(stage: HandoffStage) {
  return `步驟 ${STAGES.indexOf(stage) + 1}／${STAGES.length}：${HANDOFF_STEP_LABELS[stage]}`;
}

/** A Codex session's state as a pill: icon and label together; only a blocker gets a tone. */
export function sourceStatusPill(status: string): { tone: RowTone; icon: PillIcon; label: string } {
  switch (status) {
    case "idle":
      return { tone: "neutral", icon: "PauseCircle", label: "閒置" };
    case "notLoaded":
      return { tone: "neutral", icon: "MinusCircle", label: "未載入" };
    case "inProgress":
    case "active":
    case "running":
      return { tone: "running", icon: "HourglassMedium", label: "進行中" };
    case "systemError":
    case "error":
      return { tone: "warning", icon: "WarningCircle", label: "來源異常" };
    case "unavailable":
      return { tone: "warning", icon: "WarningCircle", label: "無法核對" };
    default:
      return { tone: "warning", icon: "Question", label: "狀態不明" };
  }
}

/** A session's last update (epoch seconds from Codex) as a relative time: 5 分鐘前 · 昨天. */
export function sessionUpdated(updatedAtSeconds: number, now = Date.now()) {
  return Number.isFinite(updatedAtSeconds) && updatedAtSeconds > 0
    ? (formatRelative(updatedAtSeconds * 1000, now) ?? "時間不明")
    : "時間不明";
}

/** Shown when a listed page holds no session of this project. */
export function emptySourcesText(hasNextPage: boolean) {
  return hasNextPage
    ? "這一頁沒有這個專案的紀錄，可以看下一頁或改用手動建立摘要。"
    : "沒有這個專案的 Codex 紀錄，可以改用手動建立摘要。";
}

/** What the source excerpt covers, said only when it is incomplete: 最近 3 輪 · 有中斷. */
export function coverageSummary(snapshot: {
  coverage: HandoffCoverage;
  partialTurns: readonly unknown[];
  pendingTurns: readonly unknown[];
}) {
  const parts = [`最近 ${snapshot.coverage.recentTurnsRequested} 輪`];
  if (snapshot.partialTurns.length) parts.push("有中斷");
  if (snapshot.pendingTurns.length) parts.push("有進行中");
  if (handoffCoverageTruncated(snapshot.coverage) || snapshot.coverage.hasOlderTurns)
    parts.push("範圍有限");
  return parts.join(" · ");
}

/** 目標 and 下一步 are required by the schema; the rest is optional. */
export function briefReady(fields: Pick<HandoffFields, "goal" | "next_action">) {
  return Boolean(fields.goal.trim() && fields.next_action.trim());
}

/** One relative path per line, blank lines dropped, as the baseline request expects. */
export function relatedPaths(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Over the limit is refused here with the same number the host enforces. */
export function relatedPathsError(text: string) {
  const count = relatedPaths(text).length;
  return count > HANDOFF_LIMITS.files
    ? `最多 ${HANDOFF_LIMITS.files} 個檔案，目前 ${count} 個。`
    : null;
}

/** The baseline in one line: 相關檔案已核對 · 2 個檔案 or 基準不完整，僅供核對. */
export function baselineSummary(baseline: Pick<HandoffBaseline, "complete" | "files">) {
  const count = `${baseline.files.length} 個檔案`;
  return baseline.complete
    ? { complete: true, text: `相關檔案已核對 · ${count}` }
    : { complete: false, text: `基準不完整，僅供核對 · ${count}` };
}

/**
 * Why 複製接續內容 is unavailable, or null when it can run. A source block is shown on its own
 * (blocked_reason), so it is not repeated here; the reviewed box sits beside the button.
 */
export function handoffCopyBlocker(state: {
  preview: Pick<HandoffPreview, "complete" | "blocked_reason"> | null;
  sourceStopped: boolean;
  permissionsChecked: boolean;
}): string | null {
  const { preview } = state;
  if (!preview) return "先核對並預覽。";
  if (preview.blocked_reason) return null;
  if (!preview.complete) return "相關檔案基準不完整，只能核對，不能複製。";
  if (!state.sourceStopped || !state.permissionsChecked)
    return "要複製，請返回修改並勾選「已在來源停止工作」與「已核對權限」。";
  return null;
}

/** Every gate the copy button checks, in one place. */
export function canCopyHandoff(state: {
  busy: boolean;
  reviewed: boolean;
  sourceStopped: boolean;
  permissionsChecked: boolean;
  preview: Pick<HandoffPreview, "complete" | "blocked_reason"> | null;
}) {
  return Boolean(
    !state.busy &&
      state.reviewed &&
      state.sourceStopped &&
      state.permissionsChecked &&
      state.preview?.complete,
  );
}

/** The copy succeeded; Desktop never claims it was sent or picked up. */
export const HANDOFF_COPIED_TEXT = "已複製，可以貼到 ChatGPT。";
