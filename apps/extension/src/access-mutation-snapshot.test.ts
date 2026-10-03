import { expect, test } from "bun:test";
import type { PanelSnapshot } from "@kairomes/protocol";
import { readAccessMutationSnapshot } from "./access-mutation-snapshot.ts";
import { PanelStreamAvailability } from "./panel-stream-availability.ts";

function snapshot(instanceId: string, grantId: string): PanelSnapshot {
  return {
    instanceId,
    sessions: [],
    workspaces: [{ id: "workspace", name: "合成專案" }],
    accessGrants: [
      {
        id: grantId,
        workspace_id: "workspace",
        workspace_name: "合成專案",
        level: "full",
        expires_at: null,
      },
    ],
  };
}

function heldResponse() {
  let resolve!: (value: PanelSnapshot) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<PanelSnapshot>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function scenario() {
  const target = { instanceId: "instance-one" };
  let connection = target;
  let latest = snapshot(target.instanceId, "original-grant");
  let invalidated = false;
  const stream = new PanelStreamAvailability();
  stream.receivedSnapshot();
  const response = heldResponse();
  const invalidate = () => {
    invalidated = true;
    stream.disconnected();
  };
  const operation = readAccessMutationSnapshot(() => response.promise, {
    instanceId: target.instanceId,
    current: () => connection === target && !invalidated,
    generation: () => stream.generation,
    snapshot: () => latest,
    invalidate,
    receive: (next) => {
      latest = next;
    },
  });
  return {
    response,
    operation,
    stream,
    invalidate,
    get latest() {
      return latest;
    },
    get invalidated() {
      return invalidated;
    },
    receive(next: PanelSnapshot) {
      latest = next;
      stream.receivedSnapshot();
    },
    replace() {
      connection = { instanceId: "instance-two" };
      latest = snapshot(connection.instanceId, "replacement-grant");
      stream.disconnected();
      stream.receivedSnapshot();
    },
  };
}

test("a delayed access response cannot roll back a newer grant and workspace snapshot", async () => {
  const state = scenario();
  const newer = { ...snapshot("instance-one", "newer-grant"), workspaces: [] };
  state.receive(newer);
  state.response.resolve(snapshot("instance-one", "old-response-grant"));
  await state.operation;
  expect(state.latest).toBe(newer);
});

test("a response spanning stream loss cannot replace the retained snapshot or establish availability", async () => {
  for (const reconnect of [false, true]) {
    const state = scenario();
    const retained = state.latest;
    state.stream.disconnected();
    if (reconnect) state.stream.receivedSnapshot();
    state.response.resolve(snapshot("instance-one", "old-stream-grant"));
    await state.operation;
    expect(state.latest).toBe(retained);
    expect(state.stream.canRestore(state.stream.generation)).toBe(reconnect);
  }
});

test("replacement sources ignore both a delayed access snapshot and its delayed failure", async () => {
  for (const reject of [false, true]) {
    const state = scenario();
    state.replace();
    const replacement = state.latest;
    if (reject) state.response.reject(new Error("Old source failure"));
    else state.response.resolve(snapshot("instance-one", "old-source-grant"));
    await state.operation;
    expect(state.latest).toBe(replacement);
    expect(state.invalidated).toBe(false);
  }
});

test("a current response with a different instance invalidates pairing instead of showing its grants", async () => {
  const state = scenario();
  const retained = state.latest;
  state.response.resolve(snapshot("instance-two", "wrong-instance-grant"));
  await expect(state.operation).rejects.toThrow("配對已失效。");
  expect(state.latest).toBe(retained);
  expect(state.invalidated).toBe(true);
  expect(state.stream.canRestore(state.stream.generation)).toBe(false);
});

test("an access 401 preserves re-pair recovery without treating its response as current", async () => {
  const state = scenario();
  const retained = state.latest;
  // The authenticated API invalidates the pairing before rejecting a 401/403.
  state.invalidate();
  state.response.reject(new Error("401"));
  await state.operation;
  expect(state.latest).toBe(retained);
  expect(state.invalidated).toBe(true);
  expect(state.stream.canRestore(state.stream.generation)).toBe(false);
});

test("a current access response is accepted and a current transport failure still needs reconciliation", async () => {
  const state = scenario();
  const next = snapshot("instance-one", "updated-grant");
  state.response.resolve(next);
  await state.operation;
  expect(state.latest).toBe(next);

  const failed = scenario();
  failed.response.reject(new Error("Response lost"));
  await expect(failed.operation).rejects.toThrow("Response lost");
});

test("a current receipt can be reconciled after EOF without rolling back activity or establishing availability", async () => {
  const stream = new PanelStreamAvailability();
  stream.receivedSnapshot();
  let latest = snapshot("instance-one", "original-grant");
  const response = heldResponse();
  let acknowledged = false;
  const reading = readAccessMutationSnapshot(() => response.promise, {
    instanceId: "instance-one",
    current: () => true,
    generation: () => stream.generation,
    snapshot: () => latest,
    invalidate: () => {},
    acknowledge: () => {
      acknowledged = true;
    },
    receive: (next) => {
      latest = next;
    },
  });
  const newer = snapshot("instance-one", "newer-grant");
  latest = newer;
  stream.disconnected();
  response.resolve(snapshot("instance-one", "old-response-grant"));
  await reading;
  expect(acknowledged).toBe(true);
  expect(latest).toBe(newer);
  expect(stream.canRestore(stream.generation)).toBe(false);
});
