import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Inputs, TerminalResultSchema } from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { startPreview } from "./preview.ts";
import { OutputBuffer, shellEnvironment, TERMINAL_LIMITS, TerminalManager } from "./terminal.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let manager: TerminalManager;
beforeEach(async () => {
  f = await fixture();
  manager = new TerminalManager(f.registry);
});
afterEach(async () => {
  await manager.close();
  await f.dispose();
});
const shell = process.platform === "win32" ? "cmd" : "bash";
const enter = process.platform === "win32" ? "\r" : "\n";
const quote = (value: string) =>
  process.platform === "win32"
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, "'\\''")}'`;
const probe = `${quote(process.execPath)} ${quote(fileURLToPath(new URL("../../../tests/pty-probe.ts", import.meta.url)))}`;

async function request(target = manager) {
  return target.request(Inputs.terminal_start.parse({ workspace_id: f.workspace.id, shell }));
}
async function approve(target: TerminalManager, id: string) {
  const review = target.approvals().find((item) => item.id === id);
  if (!review) throw new Error("Missing review");
  await target.decide(id, review.fingerprint, true);
}
async function waitOutput(target: TerminalManager, id: string, pattern: RegExp) {
  let cursor = 0;
  let text = "";
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const page = await target.poll(id, cursor);
    cursor = page.cursor;
    text += page.text;
    if (pattern.test(text)) return text;
    await Bun.sleep(25);
  }
  throw new Error(`PTY output timeout: ${JSON.stringify(text)}`);
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminal authority and lifecycle", () => {
  test("natural shell exit preserves final output", async () => {
    const { session } = await request();
    await approve(manager, session.id);
    await manager.input(session.id, `echo KAIROMES_FINAL${enter}exit${enter}`, crypto.randomUUID());
    const deadline = Date.now() + 5000;
    let state = "running";
    while (state === "running" && Date.now() < deadline) {
      state = (await manager.poll(session.id, 0)).session.state;
      if (state === "running") await Bun.sleep(25);
    }
    expect(state).toBe("exited");
    expect((await manager.poll(session.id, 0)).text).toContain("KAIROMES_FINAL");
  });
  test("requests cannot execute, approve themselves, cross instances or replay an approval", async () => {
    const other = new TerminalManager(f.registry);
    try {
      const result = await request();
      expect(result.session.state).toBe("pending");
      expect((await manager.poll(result.session.id, 0)).output).toBe("");
      expect(JSON.stringify(result)).not.toContain(f.root);
      await expect(
        manager.input(result.session.id, `echo forbidden${enter}`, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "TERMINAL_NOT_RUNNING" });
      await expect(other.poll(result.session.id, 0)).rejects.toMatchObject({
        code: "TERMINAL_NOT_FOUND",
      });
      await expect(manager.decide(result.session.id, "0".repeat(64), true)).rejects.toMatchObject({
        code: "APPROVAL_MISMATCH",
      });
      await manager.decide(result.session.id, manager.approvals()[0]?.fingerprint ?? "", false);
      expect((await manager.poll(result.session.id, 0)).session.state).toBe("denied");
      await expect(approve(manager, result.session.id)).rejects.toMatchObject({
        code: "APPROVAL_MISMATCH",
      });
    } finally {
      await other.close();
    }
  });

  test("real PTY reports TTY, correct cwd and Unicode; input retries execute once", async () => {
    expect(manager.available).toBe(true);
    const result = await request();
    const id = result.session.id;
    await approve(manager, id);
    const inputId = crypto.randomUUID();
    const command = `${probe}${enter}`;
    await manager.input(id, command, inputId);
    await manager.input(id, command, inputId);
    await expect(manager.input(id, "different", inputId)).rejects.toMatchObject({
      code: "INPUT_CONFLICT",
    });
    const text = await waitOutput(manager, id, /KAIROMES_PROBE:\{[^\n]+\}/);
    const data = JSON.parse(text.match(/KAIROMES_PROBE:(\{[^\n]+\})/)?.[1] ?? "{}");
    expect(data).toMatchObject({ tty: true, cwd: f.root, secret: null, unicode: "終端機測試🐈" });
    expect(text.match(/KAIROMES_PROBE:\{/g)?.length).toBe(1);
    expect((await manager.resize(id, 110, 31)).session).toMatchObject({ cols: 110, rows: 31 });
    await manager.stop(id);
    expect((await manager.poll(id, 0)).session.state).toBe("stopped");
    await expect(
      manager.input(id, `echo after${enter}`, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_RUNNING" });
    expect((await manager.stop(id)).session.state).toBe("stopped");
  }, 15000);

  test("stopping the shell kills background descendants", async () => {
    const { session } = await request();
    await approve(manager, session.id);
    await manager.input(session.id, `${probe} spawn-child${enter}`, crypto.randomUUID());
    const text = await waitOutput(manager, session.id, /KAIROMES_CHILD_PID:\d+\r?\n/);
    const pid = Number(text.match(/KAIROMES_CHILD_PID:(\d+)/)?.[1]);
    expect(alive(pid)).toBe(true);
    await manager.stop(session.id);
    const deadline = Date.now() + 3000;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(alive(pid)).toBe(false);
  }, 15000);

  test("expired grants and unmounted workspaces stop execution", async () => {
    let now = Date.now();
    const clocked = new TerminalManager(f.registry, () => now);
    try {
      const first = await request(clocked);
      now += TERMINAL_LIMITS.pendingMs;
      await expect(approve(clocked, first.session.id)).rejects.toMatchObject({
        code: "APPROVAL_EXPIRED",
      });
      const second = await request(clocked);
      await approve(clocked, second.session.id);
      now += TERMINAL_LIMITS.grantMs;
      await clocked.maintain();
      expect((await clocked.poll(second.session.id, 0)).session.state).toBe("expired");
      const third = await request(clocked);
      await approve(clocked, third.session.id);
      f.registry.remove(f.workspace.id);
      await clocked.maintain();
      expect((await clocked.poll(third.session.id, 0)).session.state).toBe("stopped");
    } finally {
      await clocked.close();
    }
  }, 15000);

  test("start races respect quotas and rejected paths never create sessions", async () => {
    const attempted = await Promise.allSettled(Array.from({ length: 8 }, () => request()));
    expect(attempted.filter((item) => item.status === "fulfilled")).toHaveLength(4);
    expect(manager.list()).toHaveLength(4);
    await expect(
      manager.request(Inputs.terminal_start.parse({ workspace_id: f.workspace.id, cwd: "../" })),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("bounded terminal data", () => {
  test("ring eviction and paging preserve Unicode and report lost output", () => {
    const buffer = new OutputBuffer();
    buffer.append("🐈".repeat(TERMINAL_LIMITS.buffer));
    let page = buffer.read(0);
    expect(page.truncated).toBe(true);
    expect(page.output.length).toBeLessThanOrEqual(TERMINAL_LIMITS.page);
    expect(page.output).not.toContain("�");
    while (page.has_more) page = buffer.read(page.cursor);
    expect(page.cursor).toBe(buffer.end);
    expect(buffer.read(page.cursor).output).toBe("");
    expect(() => buffer.read(page.cursor + 1)).toThrow();
  });
  test("only shell environment allowlist is inherited", () => {
    expect(
      shellEnvironment({
        PATH: "test-path",
        OPENAI_API_KEY: "canary",
        NODE_OPTIONS: "inject",
        BASH_ENV: "inject",
        ENV: "inject",
        KAIROMES_TEST_SECRET: "canary",
      }),
    ).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor", PATH: "test-path" });
  });
});

test("local approval token is separate from tool token and enables a real PTY", async () => {
  const preview = startPreview(
    f.registry,
    "<html><head><!--KAIROMES_MODE--></head><body>preview</body></html>",
    0,
  );
  const url = new URL(preview.url),
    admin = new URL(preview.approvalsUrl);
  const toolToken = new URLSearchParams(url.hash.slice(1)).get("session");
  const adminToken = new URLSearchParams(admin.hash.slice(1)).get("session");
  const post = (route: string, token: string | null, body: unknown, origin = url.origin) =>
    fetch(`${url.origin}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await post("/api/approvals", toolToken, { action: "list" })).status).toBe(401);
    expect(
      (await post("/api/tools", adminToken, { name: "workspace_list", arguments: {} })).status,
    ).toBe(401);
    expect(
      (await post("/api/approvals", adminToken, { action: "list" }, "https://attacker.example"))
        .status,
    ).toBe(403);
    const response = await post("/api/tools", toolToken, {
      name: "terminal_start",
      arguments: { workspace_id: f.workspace.id, shell },
    });
    const requested = TerminalResultSchema.parse((await response.json()).structuredContent);
    expect(requested.session.state).toBe("pending");
    const list = await (await post("/api/approvals", adminToken, { action: "list" })).json();
    const review = list.sessions[0];
    expect(JSON.stringify(requested)).not.toContain(adminToken ?? "missing-token");
    const approved = await post("/api/approvals", adminToken, {
      action: "approve",
      session_id: review.id,
      fingerprint: review.fingerprint,
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).sessions[0].state).toBe("running");
    expect(
      (
        await post("/api/approvals", adminToken, {
          action: "approve",
          session_id: review.id,
          fingerprint: review.fingerprint,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/api/approvals", adminToken, { action: "stop", session_id: review.id })).status,
    ).toBe(200);
  } finally {
    await preview.close();
  }
}, 15000);
