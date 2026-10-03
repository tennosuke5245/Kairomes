import type { DesktopSnapshot } from "./model.ts";

export function handoffInvalidReason(
  snapshot: DesktopSnapshot,
  workspaceId: string,
  statusCurrent: boolean,
) {
  if (
    !statusCurrent ||
    snapshot.runtime.state !== "running" ||
    !snapshot.companion ||
    !["running", "external"].includes(snapshot.companion.workbench.state)
  )
    return "本機工作台無法核對，接續草稿已失效。";
  if (!snapshot.companion.workspaces.some((workspace) => workspace.id === workspaceId))
    return "專案已解除掛載，接續草稿已失效。";
  return null;
}

/** Each operation belongs to one mounted workspace and source selection. */
export class HandoffRequestGuard {
  private revision = 0;
  private enabled = false;
  private workspaceId = "";

  activate(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.enabled = true;
    this.revision++;
  }

  close() {
    this.enabled = false;
    this.revision++;
  }

  begin() {
    const revision = ++this.revision;
    const workspaceId = this.workspaceId;
    return () => this.enabled && this.revision === revision && this.workspaceId === workspaceId;
  }
}
