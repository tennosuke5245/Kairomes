import { expect, test } from "bun:test";
import { handoffRequest } from "./api.ts";

test("handoff API turns an actual Tauri string rejection into a public Error", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const input = { action: "cancel" as const, draft_id: "00000000-0000-4000-8000-000000000030" };
  const calls: { command: string; args: unknown }[] = [];
  const reason = "來源仍有進行中紀錄，請停止後重新審閱。";
  // Exercise the real @tauri-apps/api invoke wrapper without a native app or source.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          throw reason;
        },
      },
    },
  });
  try {
    const error = await handoffRequest(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(reason);
    expect(calls).toEqual([{ command: "handoff_request", args: { input } }]);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
