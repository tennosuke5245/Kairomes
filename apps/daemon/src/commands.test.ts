import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type CommandResult, commandActive } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { CommandManager } from "./commands.ts";
import { ToolService } from "./tools.ts";

async function settled(service: ToolService, id: string) {
  let out = 0,
    err = 0,
    stdout = "",
    stderr = "";
  let result: CommandResult;
  const deadline = Date.now() + 7000;
  do {
    result = await service.commands.poll(id, out, err);
    out = result.stdout_cursor;
    err = result.stderr_cursor;
    stdout += result.stdout;
    stderr += result.stderr;
    if (Date.now() > deadline) throw new Error(`command did not settle: ${result.command.state}`);
    if (commandActive(result.command)) await Bun.sleep(15);
  } while (commandActive(result.command) || result.has_more);
  return { ...result, stdout, stderr };
}
async function approve(service: ToolService, id: string) {
  const entry = service.commands.approvals().find((j) => j.id === id);
  if (!entry) throw new Error("Missing approval");
  await service.commands.decide(id, entry.fingerprint, true);
}

test("expired pending requests and short full-access grants cannot launch or continue commands", async () => {
  const f = await fixture();
  let now = Date.now();
  let enabled = false;
  const manager = new CommandManager(
    f.registry,
    () =>
      enabled
        ? {
            id: "grant",
            workspace_id: f.workspace.id,
            workspace_name: "fixture",
            level: "full" as const,
            expires_at: now + 1000,
          }
        : undefined,
    () => {},
    () => now,
  );
  const request = () =>
    manager.request({
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
      argv: ["bun", "-e", "setInterval(()=>{},100)"],
    });
  try {
    const pending = await request();
    now += 300001;
    const review = manager.approvals()[0];
    await expect(
      manager.decide(pending.command.id, review?.fingerprint ?? "", true),
    ).rejects.toThrow("過期");
    expect((await manager.poll(pending.command.id, 0, 0)).command.state).toBe("expired");
    enabled = true;
    const granted = await request();
    now += 1001;
    expect((await manager.poll(granted.command.id, 0, 0)).command.state).toBe("expired");
  } finally {
    await manager.close();
    await f.dispose();
  }
});

test("command is inert until approval, retries once, separates output and returns actual nonzero exit", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const input = {
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
      argv: [
        "bun.cmd",
        "-e",
        `await Bun.write('once.txt', 'once'); console.log('喵🐱'); console.error('expected error'); process.exit(7)`,
      ],
    };
    const [a, b] = await Promise.all([
      service.commands.request(input, "mcp"),
      service.commands.request(input, "mcp"),
    ]);
    expect(a.command.id).toBe(b.command.id);
    expect(a.command.state).toBe("pending");
    expect(await stat(path.join(f.root, "once.txt")).catch(() => null)).toBeNull();
    await expect(service.commands.decide(a.command.id, "bad", true)).rejects.toThrow("不一致");
    await expect(
      service.commands.request({ ...input, argv: ["bun", "--version"] }),
    ).rejects.toThrow("不同");
    await approve(service, a.command.id);
    const done = await settled(service, a.command.id);
    expect(done.command.state).toBe("failed");
    expect(done.command.exit_code).toBe(7);
    expect(done.stdout).toContain("喵🐱");
    expect(done.stderr).toContain("expected error");
    expect(done.stdout).not.toContain("expected error");
    expect(done.output_complete).toBe(true);
    expect(await readFile(path.join(f.root, "once.txt"), "utf8")).toBe("once");
    expect((await service.commands.request(input)).command.id).toBe(a.command.id);
    expect((await service.commands.cancel(a.command.id)).command.state).toBe("failed");
    await expect(approve(service, a.command.id)).rejects.toThrow("已處理");
    expect(service.activity.list().filter((e) => e.kind === "command")).toHaveLength(1);
  } finally {
    await service.close();
    await f.dispose();
  }
}, 15000);

test("command timeout, denial, cancellation and unmount terminate with distinct states", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  const request = (timeout_ms = 5000) =>
    service.commands.request({
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms,
      argv: ["bun", "-e", "setInterval(()=>console.log('alive'),50)"],
    });
  try {
    const pending = await request();
    await service.commands.cancel(pending.command.id);
    expect((await settled(service, pending.command.id)).command.state).toBe("cancelled");
    const denied = await request();
    const approval = service.commands.approvals().find((c) => c.id === denied.command.id);
    await service.commands.decide(denied.command.id, approval?.fingerprint ?? "", false);
    expect((await settled(service, denied.command.id)).command.state).toBe("denied");
    const timed = await request(250);
    await approve(service, timed.command.id);
    expect((await settled(service, timed.command.id)).command.state).toBe("timed_out");
    const cancelled = await request();
    await approve(service, cancelled.command.id);
    await service.commands.cancel(cancelled.command.id);
    expect((await settled(service, cancelled.command.id)).command.state).toBe("cancelled");
    const unmount = await request();
    await approve(service, unmount.command.id);
    f.registry.remove(f.workspace.id);
    expect((await settled(service, unmount.command.id)).command.state).toBe("cancelled");
  } finally {
    await service.close();
    await f.dispose();
  }
}, 15000);

test("command full-access grants approve pending and new commands; revoke cancels running work", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  let valid = true;
  const request = () =>
    service.commands.request({
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
      argv: ["bun", "-e", "setInterval(()=>{},100)"],
    });
  try {
    const first = await request();
    await service.enableAccess(f.workspace.id, "full", 15, "owner", () => valid);
    expect(service.commands.list()[0]?.state).not.toBe("pending");
    const second = await request();
    expect(second.command.state).not.toBe("pending");
    await service.enableAccess(f.workspace.id, "full", 60, "owner", () => valid);
    expect(commandActive((await service.commands.poll(first.command.id, 0, 0)).command)).toBe(true);
    expect(commandActive((await service.commands.poll(second.command.id, 0, 0)).command)).toBe(
      true,
    );
    await expect(
      service.enableAccess(f.workspace.id, "full", 0 as 15, "owner", () => valid),
    ).rejects.toThrow();
    expect(commandActive((await service.commands.poll(second.command.id, 0, 0)).command)).toBe(
      true,
    );
    valid = false;
    await service.commands.maintain();
    expect((await settled(service, first.command.id)).command.state).toBe("cancelled");
    expect((await settled(service, second.command.id)).command.state).toBe("cancelled");
    const third = await request();
    expect(third.command.state).toBe("pending");
    valid = true;
    await service.enableAccess(f.workspace.id, "full", 15, "owner", () => valid);
    await service.disableAccess(f.workspace.id);
    expect((await settled(service, third.command.id)).command.state).toBe("cancelled");
  } finally {
    await service.close();
    await f.dispose();
  }
}, 15000);

test("command completion and cancellation reap background descendants and keep IPC private", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (const natural of [false, true]) {
      const result = await service.commands.request({
        workspace_id: f.workspace.id,
        cwd: "",
        request_id: crypto.randomUUID(),
        timeout_ms: 5000,
        argv: [
          "bun",
          "-e",
          `const p=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}); console.log(JSON.stringify({pid:p.pid,ipc:typeof process.send})); ${natural ? "setTimeout(()=>process.exit(0),100)" : "setInterval(()=>{},1000)"}`,
        ],
      });
      await approve(service, result.command.id);
      let output = "";
      const deadline = Date.now() + 4000;
      while (!output.includes("\n") && Date.now() < deadline) {
        output = (await service.commands.poll(result.command.id, 0, 0)).stdout;
        await Bun.sleep(10);
      }
      const data = JSON.parse(output.trim()) as { pid: number; ipc: string };
      expect(data.ipc).toBe("undefined");
      if (!natural) await service.commands.cancel(result.command.id);
      const done = await settled(service, result.command.id);
      expect(done.command.state).toBe(natural ? "succeeded" : "cancelled");
      const cleanupDeadline = Date.now() + 1500;
      while (alive(data.pid) && Date.now() < cleanupDeadline) await Bun.sleep(15);
      expect(alive(data.pid)).toBe(false);
    }
  } finally {
    await service.close();
    await f.dispose();
  }
}, 15000);

test("command result eviction preserves retry tombstones and pending requests have a quota", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  const input = {
    workspace_id: f.workspace.id,
    cwd: "",
    request_id: crypto.randomUUID(),
    timeout_ms: 5000,
    argv: ["bun", "--version"],
  };
  try {
    for (let i = 0; i < 25; i++) {
      const item = await service.commands.request(
        i === 0 ? input : { ...input, request_id: crypto.randomUUID() },
      );
      await service.commands.cancel(item.command.id);
    }
    expect(service.commands.list()).toHaveLength(24);
    await expect(service.commands.request(input)).rejects.toThrow("不在保留清單");
    await Promise.all(
      Array.from({ length: 4 }, () =>
        service.commands.request({ ...input, request_id: crypto.randomUUID() }),
      ),
    );
    await expect(
      service.commands.request({ ...input, request_id: crypto.randomUUID() }),
    ).rejects.toThrow("最多同時");
  } finally {
    await service.close();
    await f.dispose();
  }
});

test("command argv preserves literal shell syntax and output is paged without losing Unicode", async () => {
  const f = await fixture();
  const service = new ToolService(f.registry, true);
  try {
    const cmd = await service.commands.request({
      workspace_id: f.workspace.id,
      cwd: "",
      request_id: crypto.randomUUID(),
      timeout_ms: 5000,
      argv: [
        "bun",
        "-e",
        "console.log(process.argv.at(-1)); process.stdout.write('喵🐱'.repeat(4000));",
        "$HOME; echo danger & literal",
      ],
    });
    await approve(service, cmd.command.id);
    const done = await settled(service, cmd.command.id);
    expect(done.command.state).toBe("succeeded");
    expect(done.command.exit_code).toBe(0);
    expect(done.stdout).toBe(`$HOME; echo danger & literal\n${"喵🐱".repeat(4000)}`);
    expect(done.stderr).toBe("");
    expect(done.stdout_truncated).toBe(false);
    await expect(service.commands.poll(cmd.command.id, 999999, 0)).rejects.toThrow("游標");
  } finally {
    await service.close();
    await f.dispose();
  }
}, 15000);
