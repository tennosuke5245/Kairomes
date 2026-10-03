/** Unmounting invalidates browsing without pretending that the user navigated away. */
export function reconcileWorkspaceSelection(
  id: string | null,
  workspaces: readonly { id: string }[],
) {
  const removed = id !== null && !workspaces.some((workspace) => workspace.id === id);
  return { id: removed ? null : id, notifyWorkbench: !removed };
}
