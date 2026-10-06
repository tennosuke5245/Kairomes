import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandResultSchema, LIMITS, TerminalResultSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { ChangeWatchers, PollWaiters } from "./poll-wait.ts";
import { ToolService } from "./tools.ts";

describe("bounded long-poll waiters", () => {
  test("wake, timeout and close each release a waiter exactly once", async () => {
    const watchers = new ChangeWatchers();
    const states: boolean[] = [];
    const waiters = new PollWaiters(2, (waiting) => states.push(waiting));
    expect(await waiters.wait(0, watchers.subscribe("job"))).toBe(false);

    const woken = waiters.wait(10_000, watchers.subscribe("job"));
    expect(waiters.waiting).toBe(1);
    watchers.wake("other");
    expect(waiters.waiting).toBe(1);
    watchers.wake("job");
    expect(await woken).toBe(true);
    expect(waiters.waiting).toBe(0);

    const started = performance.now();
    expect(await waiters.wait(30, watchers.subscribe("job"))).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(20);

    const first = waiters.wait(10_000, watchers.subscribe("a"));
    const second = waiters.wait(10_000, watchers.subscribe("b"));
    // Over the cap a poll answers at once instead of waiting.
    expect(await waiters.wait(10_000, watchers.subscribe("c"))).toBe(false);
    waiters.close();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await waiters.wait(10_000, watchers.subscribe("a"))).toBe(false);
    expect(waiters.waiting).toBe(0);
    // Every wait gave its slot back exactly once; late wakes are harmless.
    watchers.wakeAll();
    expect(states.filter(Boolean).length).toBe(states.filter((state) => !state).length);
    expect(states.length).toBe(8);
  });

  test("a change reported while subscribing releases the waiter immediately", async () => {
    const waiters = new PollWaiters(1);
    let unsubscribed = 0;
    expect(
      await waiters.wait(10_000, (wake) => {
        wake();
        return () => {
          unsubscribed++;
        };
      }),
    ).toBe(true);
    expect(unsubscribed).toBe(1);
    expect(waiters.waiting).toBe(0);
  });
});

describe("command_poll and terminal_poll long polls", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let service: ToolService;
  beforeEach(async () => {
    f = await fixture();
    service = new ToolService(f.registry, true);
  });
  afterEach(async () => {
    await service.close();
    await f.dispose();
  });

  const command = (argv: string[]) =>
    service.commands.request(
      {
        workspace_id: f.workspace.id,
        cwd: "",
        request_id: crypto.randomUUID(),
        timeout_ms: 20_000,
        argv,
      },
      "mcp",
    );
  const approve = async (id: string) => {
    const review = service.commands.approvals().find((item) => item.id === id);
    if (!review) throw new Error("Missing approval");
    await service.commands.decide(id, review.fingerprint, true);
  };
  const commandPoll = async (args: Record<string, unknown>) => {
    const started = performance.now();
    const result = await service.call("command_poll", args, "mcp");
    expect(result.isError).not.toBe(true);
    return {
      result: CommandResultSchema.parse(result.structuredContent),
      elapsed: performance.now() - started,
    };
  };
  const terminalPoll = async (args: Record<string, unknown>) => {
    const started = performance.now();
    const result = await service.call("terminal_poll", args, "mcp");
    expect(result.isError).not.toBe(true);
    return {
      result: TerminalResultSchema.parse(result.structuredContent),
      elapsed: performance.now() - started,
    };
  };
  /**
   * Long-polls until the state leaves `from` while `trigger` runs. Each poll may also wake on
   * output, so the whole loop, not one call, must end well before a single 15 s wait.
   */
  const commandPollUntilLeaves = async (id: string, from: string, trigger: () => unknown) => {
    const started = performance.now();
    const triggered = Bun.sleep(30).then(trigger);
    let cursor = 0;
    let state = from;
    while (state === from) {
      const page = await commandPoll({ command_id: id, stdout_cursor: cursor, wait_ms: 15_000 });
      cursor = page.result.stdout_cursor;
      state = page.result.command.state;
    }
    await triggered;
    return { state, elapsed: performance.now() - started };
  };

  test("returns at the timeout when nothing changes, and at once without wait_ms", async () => {
    const pending = await command(["bun", "-e", "0"]);
    const plain = await commandPoll({ command_id: pending.command.id });
    expect(plain.result.command.state).toBe("pending");
    const waited = await commandPoll({ command_id: pending.command.id, wait_ms: 200 });
    expect(waited.result.command.state).toBe("pending");
    expect(waited.elapsed).toBeGreaterThanOrEqual(150);
  });

  test("returns early on approval, new output and exit", async () => {
    const job = await command([
      "bun",
      "-e",
      "console.log('first'); setTimeout(() => console.log('second'), 400);",
    ]);
    const id = job.command.id;
    const approval = commandPoll({ command_id: id, wait_ms: 15_000 });
    await Bun.sleep(50);
    await approve(id);
    const approved = await approval;
    expect(approved.result.command.state).not.toBe("pending");
    expect(approved.elapsed).toBeLessThan(5000);

    let stdout = "";
    let cursor = 0;
    while (!stdout.includes("first")) {
      const page = await commandPoll({ command_id: id, stdout_cursor: cursor, wait_ms: 15_000 });
      expect(page.elapsed).toBeLessThan(5000);
      stdout += page.result.stdout;
      cursor = page.result.stdout_cursor;
    }
    let done = false;
    while (!done) {
      const page = await commandPoll({ command_id: id, stdout_cursor: cursor, wait_ms: 15_000 });
      expect(page.elapsed).toBeLessThan(5000);
      stdout += page.result.stdout;
      cursor = page.result.stdout_cursor;
      done = page.result.output_complete && !page.result.has_more;
    }
    expect(stdout).toContain("second");
    // A finished command answers immediately even with wait_ms.
    const finished = await commandPoll({ command_id: id, stdout_cursor: cursor, wait_ms: 15_000 });
    expect(finished.result.command.state).toBe("succeeded");
    expect(finished.elapsed).toBeLessThan(1000);
  }, 20000);

  test("cancel and unmount release a waiting command poll", async () => {
    const cancelled = await command(["bun", "-e", "0"]);
    const released = await commandPollUntilLeaves(cancelled.command.id, "pending", () =>
      service.call("command_cancel", { command_id: cancelled.command.id }, "mcp"),
    );
    expect(released.state).toBe("cancelled");
    expect(released.elapsed).toBeLessThan(5000);

    const running = await command(["bun", "-e", "setInterval(() => {}, 1000)"]);
    await approve(running.command.id);
    for (let state = "starting"; state === "starting"; ) {
      const page = await commandPoll({ command_id: running.command.id, wait_ms: 15_000 });
      expect(page.elapsed).toBeLessThan(5000);
      state = page.result.command.state;
    }
    const unmounted = await commandPollUntilLeaves(running.command.id, "running", () =>
      f.registry.remove(f.workspace.id),
    );
    expect(unmounted.state).toBe("cancelled");
    expect(unmounted.elapsed).toBeLessThan(5000);
  }, 20000);

  test("waiting polls neither hold concurrent-call slots nor exceed the waiter cap", async () => {
    const pending = await command(["bun", "-e", "0"]);
    const args = { command_id: pending.command.id, wait_ms: 15_000 };
    const waiters = Array.from({ length: LIMITS.pollWaiters }, () => commandPoll(args));
    await Bun.sleep(50);
    // Over the waiter cap a long poll answers immediately like a plain poll.
    const extra = await commandPoll(args);
    expect(extra.result.command.state).toBe("pending");
    expect(extra.elapsed).toBeLessThan(1000);
    const reads = await Promise.all(
      Array.from({ length: LIMITS.concurrentCalls }, () =>
        service.call("file_read", { workspace_id: f.workspace.id, path: "README.md" }, "mcp"),
      ),
    );
    expect(reads.filter((result) => result.isError)).toEqual([]);
    // Closing the service releases waiters promptly.
    const closing = performance.now();
    await service.close();
    const released = await Promise.all(waiters);
    expect(performance.now() - closing).toBeLessThan(5000);
    for (const { result, elapsed } of released) {
      expect(["pending", "cancelled"]).toContain(result.command.state);
      expect(elapsed).toBeLessThan(10_000);
    }
  }, 20000);

  test("terminal polls wait for approval, output, stop and revoke", async () => {
    if (!service.terminals.available) return;
    const shell = process.platform === "win32" ? "cmd" : "bash";
    const enter = process.platform === "win32" ? "\r" : "\n";
    const start = async () => {
      const result = await service.call(
        "terminal_start",
        { workspace_id: f.workspace.id, shell },
        "mcp",
      );
      return TerminalResultSchema.parse(result.structuredContent).session;
    };
    const pending = await start();
    const timedOut = await terminalPoll({ session_id: pending.id, wait_ms: 200 });
    expect(timedOut.result.session.state).toBe("pending");
    expect(timedOut.elapsed).toBeGreaterThanOrEqual(150);
    const stopping = terminalPoll({ session_id: pending.id, wait_ms: 15_000 });
    await Bun.sleep(30);
    await service.call("terminal_stop", { session_id: pending.id }, "mcp");
    const stopped = await stopping;
    expect(stopped.result.session.state).toBe("stopped");
    expect(stopped.elapsed).toBeLessThan(5000);

    const session = await start();
    const approving = terminalPoll({ session_id: session.id, wait_ms: 15_000 });
    await Bun.sleep(30);
    await service.enableAccess(f.workspace.id, "full", 15, "panel", () => true);
    const approved = await approving;
    expect(approved.result.session.state).not.toBe("pending");
    expect(approved.elapsed).toBeLessThan(5000);

    let cursor = approved.result.cursor;
    let text = approved.result.text;
    await service.call(
      "terminal_input",
      {
        session_id: session.id,
        data: `echo LONG_POLL_${"MARK"}${enter}`,
        input_id: crypto.randomUUID(),
      },
      "mcp",
    );
    while (!text.includes("LONG_POLL_MARK")) {
      const page = await terminalPoll({ session_id: session.id, cursor, wait_ms: 15_000 });
      expect(page.elapsed).toBeLessThan(5000);
      text += page.result.text;
      cursor = page.result.cursor;
    }
    // Revoke while polls wait; trailing prompt output may wake one poll first.
    const revokedAt = performance.now();
    const revoking = Bun.sleep(30).then(() => service.disableAccess(f.workspace.id));
    let state = "running";
    while (state === "running") {
      const page = await terminalPoll({ session_id: session.id, cursor, wait_ms: 15_000 });
      cursor = page.result.cursor;
      state = page.result.session.state;
    }
    await revoking;
    expect(state).toBe("stopped");
    expect(performance.now() - revokedAt).toBeLessThan(5000);
  }, 30000);
});
