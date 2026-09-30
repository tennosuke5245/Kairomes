import type {
  ApprovalSession,
  ArtifactImportApproval,
  CommandApproval,
  FileChangeApproval,
} from "@kairomes/protocol";

export type ApprovalItem =
  | ApprovalSession
  | CommandApproval
  | FileChangeApproval
  | ArtifactImportApproval;

export function splitApprovalItems<T extends { state: string }>(items: T[]) {
  return {
    pending: items.filter((item) => item.state === "pending"),
    ongoing: items.filter((item) => ["applying", "starting", "running"].includes(item.state)),
  };
}

export function canStopOngoing(item: { state: string; argv?: unknown; shell?: unknown }) {
  return (
    (item.state === "starting" || item.state === "running") && ("argv" in item || "shell" in item)
  );
}
