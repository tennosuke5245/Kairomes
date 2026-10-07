import type { FileChange } from "@kairomes/protocol";
import { toneFor, type UiState } from "@kairomes/protocol/ui-state";
import { splitPath } from "./file-model.ts";

// 本次變更 (C2): every file the agent changed or tried to change in this workbench session,
// one row per path with the latest state. Rows only open the detail; approval stays in the
// native side panel.

export interface ChangedPath {
  key: string;
  path: string;
  name: string;
  directory: string;
  workspaceId: string;
  /** The change the row opens: one awaiting review, else the newest created. */
  changeId: string;
  operation: string;
  state: UiState;
  pending: boolean;
  updatedAt: number;
  /** How many changes in the list touched this path. */
  changes: number;
}

function operationLabel(item: FileChange["files"][number]) {
  if (item.operation === "delete") return "刪除";
  if (item.operation === "write" && item.before_version === null) return "新檔案";
  if (item.operation === "write") return "覆寫";
  return "修改";
}

const changedAt = (change: FileChange) => change.applied_at ?? change.created_at;

/**
 * Which change a path's row shows: one still awaiting review always wins, so its 取消變更
 * stays reachable; otherwise the most recently created one. applied_at is display only.
 */
function decides(candidate: FileChange, current: FileChange) {
  const waiting = candidate.state === "pending";
  if (waiting !== (current.state === "pending")) return waiting;
  return candidate.created_at >= current.created_at;
}

/** Groups changes by workspace and path; one row per path, newest activity first. */
export function summarizeChanges(
  changes: readonly FileChange[] | undefined,
  workspaceId?: string | null,
): ChangedPath[] {
  const rows = new Map<string, { change: FileChange; row: ChangedPath }>();
  const ordered = [...(changes ?? [])]
    .filter((change) => !workspaceId || change.workspace_id === workspaceId)
    .sort((a, b) => a.created_at - b.created_at);
  for (const change of ordered) {
    for (const item of change.files) {
      const key = `${change.workspace_id}:${item.path}`;
      const prior = rows.get(key);
      const count = (prior?.row.changes ?? 0) + 1;
      if (prior && !decides(change, prior.change)) {
        prior.row.changes = count;
        continue;
      }
      rows.set(key, {
        change,
        row: {
          key,
          path: item.path,
          ...splitPath(item.path),
          workspaceId: change.workspace_id,
          changeId: change.id,
          operation: operationLabel(item),
          state: toneFor("file_change", change.state),
          pending: change.state === "pending",
          updatedAt: changedAt(change),
          changes: count,
        },
      });
    }
  }
  return [...rows.values()].map(({ row }) => row).sort((a, b) => b.updatedAt - a.updatedAt);
}
