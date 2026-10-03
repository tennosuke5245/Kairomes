import { expect, spyOn, test } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import { CodexRpc } from "./codex-rpc.ts";
import { openHandoffSource } from "./handoff-source.ts";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("合成來源未進入等待狀態。");
}

/** No real filesystem, program resolution, reader, environment or source is used. */
function isolatedSource(
  options: { pathGate?: ReturnType<typeof deferred>; startGate?: ReturnType<typeof deferred> } = {},
) {
  let pathWaiting = false;
  const originals = {
    realpath: fs.realpath,
    stat: fs.stat,
    which: Bun.which,
    start: CodexRpc.prototype.start,
    close: CodexRpc.prototype.close,
    request: CodexRpc.prototype.request,
  };
  const realpath = spyOn(fs, "realpath").mockImplementation((async (input: PathLike) => {
    if (String(input) === "synthetic-workspace") {
      pathWaiting = true;
      await options.pathGate?.promise;
      return "synthetic-resolved-workspace";
    }
    return "synthetic-resolved-source-home";
  }) as typeof fs.realpath);
  const stat = spyOn(fs, "stat").mockImplementation((async () => ({
    isDirectory: () => true,
  })) as unknown as typeof fs.stat);
  const which = spyOn(Bun, "which").mockReturnValue("synthetic-codex");
  const start = spyOn(CodexRpc.prototype, "start").mockImplementation(async () => {
    await options.startGate?.promise;
  });
  const close = spyOn(CodexRpc.prototype, "close").mockResolvedValue(undefined);
  const request = spyOn(CodexRpc.prototype, "request").mockResolvedValue({
    data: [],
    nextCursor: null,
  });
  return {
    pathWaiting: () => pathWaiting,
    start,
    close,
    request,
    restore() {
      options.pathGate?.release();
      options.startGate?.release();
      realpath.mockRestore();
      stat.mockRestore();
      which.mockRestore();
      start.mockRestore();
      close.mockRestore();
      request.mockRestore();
      expect(fs.realpath).toBe(originals.realpath);
      expect(fs.stat).toBe(originals.stat);
      expect(Bun.which).toBe(originals.which);
      expect(CodexRpc.prototype.start).toBe(originals.start);
      expect(CodexRpc.prototype.close).toBe(originals.close);
      expect(CodexRpc.prototype.request).toBe(originals.request);
    },
  };
}

test("H1 cancellation during project realpath prevents the source reader from starting", async () => {
  const gate = deferred();
  const f = isolatedSource({ pathGate: gate });
  const controller = new AbortController();
  const pending = openHandoffSource(
    "synthetic-workspace",
    "synthetic-source-home",
    controller.signal,
  ).catch((error: unknown) => error);
  try {
    await until(f.pathWaiting);
    controller.abort();
    gate.release();
    expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalled();
  } finally {
    gate.release();
    await pending;
    f.restore();
  }
});

test("H1 cancelled initialization cannot return a source even if its start resolves late", async () => {
  const gate = deferred();
  const f = isolatedSource({ startGate: gate });
  const controller = new AbortController();
  const pending = openHandoffSource(
    "synthetic-workspace",
    "synthetic-source-home",
    controller.signal,
  ).catch((error: unknown) => error);
  try {
    await until(() => f.start.mock.calls.length === 1);
    controller.abort();
    expect(f.close).toHaveBeenCalled();
    gate.release();
    expect(await pending).toMatchObject({ code: "HANDOFF_CANCELLED" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(2);
  } finally {
    gate.release();
    await pending;
    f.restore();
  }
});

test("H1 an active source still lists only the resolved project and keeps explicit close ownership", async () => {
  const f = isolatedSource();
  let source: Awaited<ReturnType<typeof openHandoffSource>> | undefined;
  try {
    source = await openHandoffSource(
      "synthetic-workspace",
      "synthetic-source-home",
      new AbortController().signal,
    );
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(await source.list()).toEqual({ sessions: [], nextCursor: null });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledWith(
      "thread/list",
      expect.objectContaining({ cwd: "synthetic-resolved-workspace", useStateDbOnly: true }),
    );
    expect(f.close).not.toHaveBeenCalled();
    await source.close();
    source = undefined;
    expect(f.close).toHaveBeenCalledTimes(1);
  } finally {
    await source?.close();
    f.restore();
  }
});
