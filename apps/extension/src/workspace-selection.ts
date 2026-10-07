/** Unmounting invalidates browsing without pretending that the user navigated away. */
export function reconcileWorkspaceSelection(
  id: string | null,
  workspaces: readonly { id: string }[],
) {
  const removed = id !== null && !workspaces.some((workspace) => workspace.id === id);
  return { id: removed ? null : id, notifyWorkbench: !removed };
}

export const ALL_PROJECTS = "全部專案";

/** The switcher's label and icon: Stack for all projects, Folder for one (spec §6). */
export function workspaceLabel(
  id: string | null,
  workspaces: readonly { id: string; name: string }[],
): { label: string; icon: "Stack" | "Folder" } {
  const found = id === null ? undefined : workspaces.find((workspace) => workspace.id === id);
  return found ? { label: found.name, icon: "Folder" } : { label: ALL_PROJECTS, icon: "Stack" };
}
