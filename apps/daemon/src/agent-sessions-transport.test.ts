import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { handoffSourceBlock } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { CodexSessionSource } from "./agent-sessions.ts";
import { CodexRpc } from "./codex-rpc.ts";

function transport(directory: string, workspace: string, mode = "valid") {
  return new CodexRpc(
    directory,
    process.execPath,
    1000,
    [
      fileURLToPath(new URL("../../../tests/codex-handoff-source-fixture.ts", import.meta.url)),
      workspace,
      mode,
    ],
    { experimentalApi: true },
  );
}

test("isolated stdio H1 reader keeps exact project scope, filters private items and blocks pending readiness", async () => {
  const f = await fixture();
  const previous = process.env.KAIROMES_HANDOFF_SYNTHETIC_SECRET;
  process.env.KAIROMES_HANDOFF_SYNTHETIC_SECRET = "synthetic-value-never-forwarded";
  const rpc = transport(f.state, f.root);
  let source: CodexSessionSource | undefined;
  try {
    source = await CodexSessionSource.open(rpc, f.root);
    const listed = await source.list();
    expect(listed.sessions.map((session) => session.id)).toEqual(["synthetic-listed"]);
    await expect(source.snapshot("foreign")).rejects.toMatchObject({ code: "SESSION_SCOPE" });
    const snapshot = await source.snapshot("synthetic-listed");
    expect(snapshot.completedTurns).toHaveLength(1);
    expect(snapshot.partialTurns).toHaveLength(1);
    expect(snapshot.partialTurns[0]?.sourceStatus).toBe("interrupted");
    expect(snapshot.partialTurns[0]?.actions[0]?.exitCode).toBe(1);
    expect(snapshot.pendingTurns).toEqual([{ id: "pending", sourceStatus: "inProgress" }]);
    expect(snapshot.coverage.hasOlderTurns).toBe(true);
    expect(snapshot.taskState).toEqual({ goal: null, plan: null, decisions: null });
    expect(handoffSourceBlock(snapshot.source.status, snapshot.pendingTurns.length)?.code).toBe(
      "HANDOFF_PENDING",
    );
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    expect(JSON.stringify(snapshot)).not.toContain("ghp_");
    const report = (await rpc.request("fixture/report")) as {
      calls: string[];
      secretInherited: boolean;
      sourceHomeMatchesCwd: boolean;
    };
    expect(report.calls).toEqual([
      "initialize",
      "initialized",
      "thread/list",
      "thread/read",
      "thread/turns/list",
      "fixture/report",
    ]);
    expect(report.secretInherited).toBe(false);
    expect(report.sourceHomeMatchesCwd).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.KAIROMES_HANDOFF_SYNTHETIC_SECRET;
    else process.env.KAIROMES_HANDOFF_SYNTHETIC_SECRET = previous;
    if (source) await source.close();
    else await rpc.close();
    expect(rpc.connected).toBe(false);
    await f.dispose();
  }
});

for (const mode of ["malformed-thread", "malformed-turn"]) {
  test(`isolated stdio H1 reader rejects ${mode} before producing a snapshot`, async () => {
    const f = await fixture();
    const rpc = transport(f.state, f.root, mode);
    let source: CodexSessionSource | undefined;
    try {
      source = await CodexSessionSource.open(rpc, f.root);
      await source.list();
      await expect(source.snapshot("synthetic-listed")).rejects.toBeInstanceOf(Error);
      const report = (await rpc.request("fixture/report")) as { calls: string[] };
      expect(report.calls.filter((method) => method.startsWith("thread/"))).toEqual(
        mode === "malformed-thread"
          ? ["thread/list", "thread/read"]
          : ["thread/list", "thread/read", "thread/turns/list"],
      );
    } finally {
      if (source) await source.close();
      else await rpc.close();
      await f.dispose();
    }
  });
}
