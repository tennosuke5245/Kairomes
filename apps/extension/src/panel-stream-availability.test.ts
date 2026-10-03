import { expect, test } from "bun:test";
import { ApprovalMutationTracker } from "./approval-mutation.ts";
import { PanelStreamAvailability } from "./panel-stream-availability.ts";

test("an approval read cannot establish availability before the first stream snapshot", () => {
  const stream = new PanelStreamAvailability();
  const readGeneration = stream.generation;
  expect(stream.canRestore(readGeneration)).toBe(false);
  stream.receivedSnapshot();
  expect(stream.canRestore(readGeneration)).toBe(true);
});

test("a held approval read cannot restore controls after EOF or a replacement stream", async () => {
  for (const reconnect of [false, true]) {
    const stream = new PanelStreamAvailability();
    stream.receivedSnapshot();
    const readGeneration = stream.generation;
    const tracker = new ApprovalMutationTracker();
    const source = "synthetic-instance";
    const request = {
      id: "request",
      fingerprint: "same",
      state: "pending" as const,
      expires_at: 100,
    };
    tracker.bind(source);
    tracker.markUnknown(source, request);
    let release: (() => void) | undefined;
    let available = false;
    const read = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      // Read-only reconciliation can settle an identity, but cannot make a stream ready.
      tracker.observe(source, [request], 50);
      if (stream.canRestore(readGeneration)) available = true;
    });
    stream.disconnected();
    if (reconnect) stream.receivedSnapshot();
    release?.();
    await read;
    expect(available).toBe(false);
    expect(tracker.isLocked(source, request)).toBe(true);
    expect(stream.canRestore(stream.generation)).toBe(reconnect);
  }
});

test("a fresh stream remains authoritative when an older read returns", () => {
  const stream = new PanelStreamAvailability();
  stream.receivedSnapshot();
  const oldRead = stream.generation;
  stream.disconnected();
  stream.receivedSnapshot();
  let available = true;
  if (stream.canRestore(oldRead)) available = true;
  expect(available).toBe(true);
  expect(stream.canRestore(oldRead)).toBe(false);
  expect(stream.canRestore(stream.generation)).toBe(true);
});
