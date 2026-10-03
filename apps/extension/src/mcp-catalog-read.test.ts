import { expect, test } from "bun:test";
import { readMcpCatalog } from "./mcp-catalog-read.ts";

test("a catalog 401 cannot replace re-pair recovery with refresh recovery", async () => {
  let needsPairing = false;
  let repair = "refresh";
  let received = false;
  await readMcpCatalog(
    async () => {
      // Same transition performed by the authenticated fetch on a 401/403.
      needsPairing = true;
      repair = "pair";
      throw new Error("401");
    },
    () => !needsPairing,
    () => {
      received = true;
    },
    () => {
      repair = "refresh";
    },
  );
  expect(repair).toBe("pair");
  expect(received).toBe(false);
});

test("a read begun before a mutation discards both its catalog and its late failure", async () => {
  for (const reject of [false, true]) {
    let operation = 0;
    const requestedAt = operation;
    const results: string[] = [];
    await readMcpCatalog(
      async () => {
        operation += 2;
        if (reject) throw new Error("Old failure");
        return "old catalog";
      },
      () => requestedAt === operation,
      (state) => results.push(state),
      () => results.push("failed"),
    );
    expect(results).toEqual([]);
  }
});

test("a current authenticated catalog is received, while a current read error is reported", async () => {
  const results: string[] = [];
  await readMcpCatalog(
    async () => "fresh",
    () => true,
    (state) => results.push(state),
    () => {},
  );
  await readMcpCatalog(
    async () => {
      throw new Error("Offline");
    },
    () => true,
    () => {},
    () => results.push("failed"),
  );
  expect(results).toEqual(["fresh", "failed"]);
});

test("a read spanning SSE loss cannot overwrite offline recovery, even after a new stream recovers", async () => {
  for (const recover of [false, true]) {
    let available = true;
    let streamGeneration = 1;
    const requestedAt = streamGeneration;
    let primaryStatus = "";
    await readMcpCatalog(
      async () => {
        available = false;
        streamGeneration++;
        primaryStatus = "顯示上次快照。";
        if (recover) available = true;
        throw new Error("late catalog failure");
      },
      () => available && streamGeneration === requestedAt,
      () => {},
      () => {
        primaryStatus = "結果待確認。";
      },
    );
    expect(primaryStatus).toBe("顯示上次快照。");
  }
});
