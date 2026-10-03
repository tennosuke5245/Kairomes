import { expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture } from "../../../tests/fixtures.ts";
import { CodexRpc } from "./codex-rpc.ts";

test("actual stdio transport correlates replies, bounds waits and rejects pending calls on exit", async () => {
  const f = await fixture();
  const rpc = new CodexRpc(f.state, process.execPath, 1000, [
    fileURLToPath(new URL("../../../tests/codex-child-fixture.ts", import.meta.url)),
  ]);
  try {
    await rpc.start();
    expect(rpc.connected).toBe(true);
    const results = await Promise.all([
      rpc.request("test/echo", { text: "喵～" }),
      rpc.request("test/echo", { index: 2 }),
    ]);
    expect(results).toEqual([{ received: { text: "喵～" } }, { received: { index: 2 } }]);
    // Await real pipe I/O before entering Bun's rejection matcher.
    const rejection = await rpc.request("test/reject").catch((error: Error) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("拒絕此操作");
    const timeout = await rpc.request("test/timeout").catch((error: Error) => error);
    expect((timeout as Error).message).toContain("可能已送達");
    const exit = await rpc.request("test/exit").catch((error: Error) => error);
    expect((exit as Error).message).toContain("已斷線");
    expect(rpc.connected).toBe(false);
  } finally {
    await rpc.close();
    await f.dispose();
  }
});

test("closing the read-only source child cancels pending RPC and releases its transport", async () => {
  const f = await fixture();
  const rpc = new CodexRpc(f.state, process.execPath, 20000, [
    fileURLToPath(new URL("../../../tests/codex-child-fixture.ts", import.meta.url)),
  ]);
  try {
    await rpc.start();
    const pending = rpc.request("test/timeout").catch((error: Error) => error);
    await rpc.close();
    expect(await pending).toMatchObject({ code: "CODEX_DISCONNECTED" });
    expect(rpc.connected).toBe(false);
  } finally {
    await rpc.close();
    await f.dispose();
  }
});

test("stdin failure retains ownership until the synthetic source child has exited", async () => {
  const f = await fixture();
  const rpc = new CodexRpc(f.state, process.execPath, 1000, [
    fileURLToPath(new URL("../../../tests/codex-handoff-source-fixture.ts", import.meta.url)),
    f.root,
  ]);
  let pid: number | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  const alive = () => {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await rpc.start();
    const closedInput = (await rpc.request("fixture/keep-alive")) as { pid: number };
    pid = closedInput.pid;
    expect(Number.isInteger(pid)).toBe(true);
    expect(alive()).toBe(true);
    child = (rpc as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const pending = rpc.request("fixture/wait").catch((error) => error);
    // Fault injection at the real parent-side pipe, with an actual fixed fixture child.
    child.stdin.destroy(new Error("Synthetic stdin transport failure"));
    const failure = await pending;
    expect(failure).toMatchObject({ code: "CODEX_DISCONNECTED" });
    await rpc.close();
    expect(alive()).toBe(false);
    expect(rpc.connected).toBe(false);
  } finally {
    // Only the PID returned by this fixed synthetic peer can be cleaned up here.
    if (child && alive()) {
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }
    await rpc.close();
    await f.dispose();
  }
});
