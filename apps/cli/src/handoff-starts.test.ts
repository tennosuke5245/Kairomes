import { expect, test } from "bun:test";
import { fixture } from "../../../tests/fixtures.ts";
import { HandoffBriefs } from "../../daemon/src/handoff-brief.ts";
import { HandoffStarts } from "./handoff-starts.ts";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
const input = () => ({
  action: "start" as const,
  provider: "manual" as const,
  workspace_id: "00000000-0000-4000-8000-000000000010",
  draft_id: crypto.randomUUID(),
});
const signal = () => new AbortController().signal;

test("Companion early cancel during initialization never enters the real draft service or opens a source", async () => {
  const f = await fixture();
  let readers = 0;
  const briefs = new HandoffBriefs(f.registry, async () => {
    readers++;
    throw new Error("Source must never open after cancelled initialization");
  });
  const starts = new HandoffStarts();
  const preparing = deferred<void>();
  const action = { ...input(), workspace_id: f.workspace.id, provider: "codex" as const };
  try {
    const pending = starts
      .run(action, signal(), async (check) => {
        await preparing.promise;
        check();
        return briefs;
      })
      .catch((error) => error);
    starts.cancel(action.draft_id);
    preparing.resolve();
    expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(readers).toBe(0);
    await expect(
      briefs.perform({ action: "baseline", draft_id: action.draft_id, paths: [] }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
    const replacement = await starts.run(
      { ...action, provider: "manual" },
      signal(),
      async () => briefs,
    );
    expect(replacement).toMatchObject({ draft_id: action.draft_id });
  } finally {
    starts.close();
    await briefs.close();
    await f.dispose();
  }
});

test("Companion duplicate and cancelled UUID stay reserved until their initializer settles", async () => {
  const starts = new HandoffStarts();
  const ready = deferred<void>();
  let calls = 0;
  let initialized = 0;
  const service = {
    async perform() {
      calls++;
      return {};
    },
  };
  const action = input();
  const pending = starts
    .run(action, signal(), async () => {
      initialized++;
      await ready.promise;
      return service;
    })
    .catch((error) => error);
  await expect(starts.run(action, signal(), async () => service)).rejects.toMatchObject({
    code: "HANDOFF_DUPLICATE",
  });
  starts.cancel(action.draft_id);
  await expect(starts.run(action, signal(), async () => service)).rejects.toMatchObject({
    code: "HANDOFF_DUPLICATE",
  });
  ready.resolve();
  expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
  expect(initialized).toBe(1);
  expect(calls).toBe(0);
  await starts.run(action, signal(), async () => service);
  expect(calls).toBe(1);
  starts.close();
});

test("Companion pending capacity is four, and cancellation clears all before performing", async () => {
  const starts = new HandoffStarts();
  const ready = deferred<void>();
  let calls = 0;
  const service = {
    async perform() {
      calls++;
      return {};
    },
  };
  const requests = Array.from({ length: 4 }, () =>
    starts
      .run(input(), signal(), async () => {
        await ready.promise;
        return service;
      })
      .catch((error) => error),
  );
  await expect(starts.run(input(), signal(), async () => service)).rejects.toMatchObject({
    code: "HANDOFF_LIMIT",
  });
  starts.cancelAll();
  ready.resolve();
  for (const error of await Promise.all(requests))
    expect(error).toMatchObject({ code: "HANDOFF_CANCELLED" });
  expect(calls).toBe(0);
  await starts.run(input(), signal(), async () => service);
  expect(calls).toBe(1);
  starts.close();
});

test("Companion expired initialization keeps its UUID reserved until it settles", async () => {
  let clock = 0;
  const starts = new HandoffStarts(() => clock);
  const oldReady = deferred<void>();
  const action = input();
  let calls = 0;
  const service = {
    async perform() {
      calls++;
      return {};
    },
  };
  const oldStart = starts
    .run(action, signal(), async () => {
      await oldReady.promise;
      return service;
    })
    .catch((error) => error);
  clock += 10 * 60 * 1000;
  await expect(starts.run(action, signal(), async () => service)).rejects.toMatchObject({
    code: "HANDOFF_DUPLICATE",
  });
  oldReady.resolve();
  expect(await oldStart).toMatchObject({ code: "HANDOFF_CANCELLED" });
  await starts.run(action, signal(), async () => service);
  expect(calls).toBe(1);
  starts.close();
});

test("Companion request abort, close and initialization failure release only their own start", async () => {
  const starts = new HandoffStarts();
  const ready = deferred<void>();
  const controller = new AbortController();
  let calls = 0;
  const service = {
    async perform() {
      calls++;
      return {};
    },
  };
  const action = input();
  const pending = starts
    .run(action, controller.signal, async () => {
      await ready.promise;
      return service;
    })
    .catch((error) => error);
  controller.abort();
  ready.resolve();
  expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(
    starts.run(action, alreadyAborted.signal, async () => service),
  ).rejects.toMatchObject({ code: "HANDOFF_CANCELLED" });
  await expect(
    starts.run(action, signal(), async () => {
      throw new Error("Synthetic initialization failure");
    }),
  ).rejects.toThrow("Synthetic initialization failure");
  await starts.run(action, signal(), async () => service);
  expect(calls).toBe(1);
  const closing = deferred<void>();
  const closePending = starts
    .run(input(), signal(), async () => {
      await closing.promise;
      return service;
    })
    .catch((error) => error);
  starts.close();
  closing.resolve();
  expect(await closePending).toMatchObject({ code: "HANDOFF_CANCELLED" });
  expect(calls).toBe(1);
  await expect(starts.run(input(), signal(), async () => service)).rejects.toMatchObject({
    code: "HANDOFF_EXPIRED",
  });
});

test("Companion request abort immediately after successful draft creation still clears the undelivered draft", async () => {
  const f = await fixture();
  const starts = new HandoffStarts();
  const briefs = new HandoffBriefs(f.registry);
  const controller = new AbortController();
  const action = { ...input(), workspace_id: f.workspace.id };
  try {
    const cancelled = starts.run(action, controller.signal, async () => ({
      async perform(value, sourceSignal) {
        const result = await briefs.perform(value, sourceSignal);
        controller.abort();
        return result;
      },
    }));
    await expect(cancelled).rejects.toMatchObject({ code: "HANDOFF_CANCELLED" });
    await expect(
      briefs.perform({ action: "baseline", draft_id: action.draft_id, paths: [] }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
  } finally {
    starts.close();
    await briefs.close();
    await f.dispose();
  }
});

test("Companion start TTL expiring after creation clears a real draft whose own TTL is still valid", async () => {
  const f = await fixture();
  let clock = 0;
  let readers = 0;
  let closes = 0;
  const starts = new HandoffStarts(() => clock);
  const briefs = new HandoffBriefs(
    f.registry,
    async () => {
      readers++;
      return {
        async list() {
          return { sessions: [], nextCursor: null };
        },
        async snapshot(): Promise<never> {
          throw new Error("Unused synthetic source read");
        },
        async close() {
          closes++;
        },
      };
    },
    () => clock,
  );
  const action = { ...input(), workspace_id: f.workspace.id, provider: "codex" as const };
  try {
    const expired = starts.run(action, signal(), async () => {
      clock = 9 * 60 * 1000;
      return {
        async perform(value, sourceSignal) {
          const result = await briefs.perform(value, sourceSignal);
          if (typeof value === "object" && value && "action" in value && value.action === "start")
            clock = 10 * 60 * 1000;
          return result;
        },
      };
    });
    await expect(expired).rejects.toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(readers).toBe(1);
    expect(closes).toBe(1);
    await expect(
      briefs.perform({ action: "baseline", draft_id: action.draft_id, paths: [] }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
    expect(
      await starts.run({ ...action, provider: "manual" }, signal(), async () => briefs),
    ).toMatchObject({ draft_id: action.draft_id });
  } finally {
    starts.close();
    await briefs.close();
    await f.dispose();
  }
});

test("Companion delayed old success cannot delete a new generation after expiry and cancellation", async () => {
  const f = await fixture();
  let clock = 0;
  const starts = new HandoffStarts(() => clock);
  const briefs = new HandoffBriefs(f.registry, undefined, () => clock);
  const created = deferred<void>();
  const reply = deferred<void>();
  const action = { ...input(), workspace_id: f.workspace.id };
  try {
    const oldStart = starts
      .run(action, signal(), async () => ({
        async perform(value, sourceSignal) {
          if (
            typeof value !== "object" ||
            !value ||
            !("action" in value) ||
            value.action !== "start"
          )
            return briefs.perform(value, sourceSignal);
          clock = 9 * 60 * 1000;
          const result = await briefs.perform(value, sourceSignal);
          created.resolve();
          await reply.promise;
          return result;
        },
      }))
      .catch((error) => error);
    await created.promise;
    starts.cancel(action.draft_id);
    await briefs.perform({ action: "cancel", draft_id: action.draft_id });
    clock = 10 * 60 * 1000;
    await expect(starts.run(action, signal(), async () => briefs)).rejects.toMatchObject({
      code: "HANDOFF_DUPLICATE",
    });
    reply.resolve();
    expect(await oldStart).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(await starts.run(action, signal(), async () => briefs)).toMatchObject({
      draft_id: action.draft_id,
    });
    expect(
      await briefs.perform({ action: "baseline", draft_id: action.draft_id, paths: ["README.md"] }),
    ).toMatchObject({ complete: true });
  } finally {
    reply.resolve();
    starts.close();
    await briefs.close();
    await f.dispose();
  }
});

test("Companion close retains ownership until a delayed successful start is cleaned up", async () => {
  const f = await fixture();
  const starts = new HandoffStarts();
  const briefs = new HandoffBriefs(f.registry);
  const created = deferred<void>();
  const reply = deferred<void>();
  const action = { ...input(), workspace_id: f.workspace.id };
  try {
    const closing = starts
      .run(action, signal(), async () => ({
        async perform(value, sourceSignal) {
          const result = await briefs.perform(value, sourceSignal);
          if (typeof value === "object" && value && "action" in value && value.action === "start") {
            created.resolve();
            await reply.promise;
          }
          return result;
        },
      }))
      .catch((error) => error);
    await created.promise;
    starts.close();
    await expect(starts.run(action, signal(), async () => briefs)).rejects.toMatchObject({
      code: "HANDOFF_EXPIRED",
    });
    reply.resolve();
    expect(await closing).toMatchObject({ code: "HANDOFF_CANCELLED" });
    await expect(
      briefs.perform({ action: "baseline", draft_id: action.draft_id, paths: [] }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
  } finally {
    reply.resolve();
    starts.close();
    await briefs.close();
    await f.dispose();
  }
});
