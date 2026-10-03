import type { ActivitySnapshot } from "@kairomes/protocol";

export interface WorkspaceNameHistory {
  instanceId: string;
  names: ReadonlyMap<string, string>;
}

/** Display labels only: never use these names as evidence of a mounted workspace. */
export function retainWorkspaceNames(
  previous: WorkspaceNameHistory | undefined,
  snapshot: ActivitySnapshot,
  fixedWorkspaceIds: Iterable<string | undefined>,
): WorkspaceNameHistory {
  const referenced = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.workspaceId) referenced.add(entry.workspaceId);
  }
  for (const id of fixedWorkspaceIds) {
    if (id) referenced.add(id);
  }
  const prior = previous?.instanceId === snapshot.instanceId ? previous.names : undefined;
  const mounted = new Map(snapshot.workspaces?.map((workspace) => [workspace.id, workspace.name]));
  const names = new Map<string, string>();
  for (const id of referenced) {
    const name = mounted.get(id) ?? prior?.get(id);
    if (name !== undefined) names.set(id, name);
  }
  if (
    previous?.instanceId === snapshot.instanceId &&
    previous.names.size === names.size &&
    [...names].every(([id, name]) => previous.names.get(id) === name)
  )
    return previous;
  return { instanceId: snapshot.instanceId, names };
}
