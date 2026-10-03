import type { PanelSnapshot } from "@kairomes/protocol";

interface AccessSnapshotContext {
  instanceId: string;
  current(): boolean;
  generation(): number;
  snapshot(): PanelSnapshot | undefined;
  invalidate(): void;
  acknowledge?(snapshot: PanelSnapshot): void;
  receive(snapshot: PanelSnapshot): void;
}

/** A mutation response cannot replace a newer stream snapshot or a replacement connection. */
export async function readAccessMutationSnapshot(
  read: () => Promise<PanelSnapshot>,
  context: AccessSnapshotContext,
) {
  const snapshotAtChange = context.snapshot();
  const streamGeneration = context.generation();
  let next: PanelSnapshot;
  try {
    next = await read();
  } catch (cause) {
    if (!context.current()) return;
    throw cause;
  }
  if (!context.current()) return;
  if (next.instanceId !== context.instanceId) {
    context.invalidate();
    throw new Error("配對已失效。");
  }
  context.acknowledge?.(next);
  if (context.generation() !== streamGeneration || context.snapshot() !== snapshotAtChange) return;
  context.receive(next);
}
