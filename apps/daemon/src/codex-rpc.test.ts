import { expect, test } from "bun:test";
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
