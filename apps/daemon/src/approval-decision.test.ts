import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type ArtifactImport,
  type Command,
  DENIAL_REASON_MAX_LENGTH,
  DenialReasonSchema,
  type TerminalSession,
} from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { ActivityStore } from "./activity.ts";
import { denialReason } from "./approval-decision.ts";
import { ArtifactImportManager } from "./artifact-imports.ts";
import { CommandManager } from "./commands.ts";
import { FileChangeManager } from "./file-changes.ts";
import { TerminalManager } from "./terminal.ts";

const char = (code: number) => String.fromCodePoint(code);
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.dispose();
});

test("denial reasons never hand Kairomes URLs, pairing links or tokens to the model", () => {
  const hex = "0123456789abcdef".repeat(4);
  const instance = "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4";
  const cases: [string, string][] = [
    [`用這個核准頁 http://127.0.0.1:4318/approvals#session=${hex}`, "用這個核准頁 [LOCAL URL]"],
    [`http://127.0.0.1:4318/pair#code=${hex}&instance=${instance}`, "[LOCAL URL]"],
    [`見 HTTP://LOCALHOST:5173/#session=${hex.toUpperCase()}。`, "見 [LOCAL URL]。"],
    ["改用 http://[::1]:8080/x 或 localhost:3000", "改用 [LOCAL URL] 或 [LOCAL URL]"],
    ["https://app.localhost/ 與 http://0.0.0.0:80", "[LOCAL URL] 與 [LOCAL URL]"],
    [`127.0.0.1:4318/approvals#session=${hex}`, "[LOCAL URL]"],
    [`token ${hex}`, "token [TOKEN REDACTED]"],
    [
      `CONTROL_PLANE_API_KEY=sk-proj-${"A".repeat(24)}`,
      "CONTROL_PLANE_API_KEY=[OPENAI KEY REDACTED]",
    ],
  ];
  for (const [reason, expected] of cases) expect(denialReason(false, reason)).toBe(expected);
  // Public URLs, short hex values and plain ports stay as typed.
  for (const reason of [
    "請參考 https://example.com/docs#section",
    "commit abc1234、port 4318 與 127.0.0.1",
    "版本 0.3.0 的 http 範例",
  ])
    expect(denialReason(false, reason)).toBe(reason);
  // Markers are never longer than what they replace, so dense input still fits the schema.
  for (const reason of [
    "http://[::1] ".repeat(15),
    "localhost:1 ".repeat(16),
    `${hex} `.repeat(3),
    `http://127.0.0.1:1/#session=${hex}`.padEnd(DENIAL_REASON_MAX_LENGTH, "長"),
  ]) {
    const redacted = denialReason(false, reason) ?? "";
    expect(redacted).not.toMatch(/localhost|127\.0\.0\.1|::1|[0-9a-f]{64}/i);
    expect(DenialReasonSchema.parse(redacted)).toBe(redacted);
    expect([...redacted].length).toBeLessThanOrEqual(DENIAL_REASON_MAX_LENGTH);
  }
});

async function rejects(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("Expected the decision to be rejected");
}

test("file changes store a trimmed denial reason and keep diffs only while active", async () => {
  const changes = new FileChangeManager(f.registry, () => undefined);
  try {
    const request = (path: string) =>
      changes.request(
        {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          summary: `新增 ${path}`,
          changes: [
            { operation: "write", path, expected_version: null, content: "第一行\n第二行\n" },
          ],
        },
        "mcp",
      );
    const first = (await request("first.md")).change;
    const review = changes.approvals().find((item) => item.id === first.id);
    expect(review).toMatchObject({ state: "pending", diff_available: true });
    expect(review?.diff).toContain("+第二行");

    // A reason never comes with an approval, and invalid text consumes nothing.
    const fingerprint = review?.fingerprint ?? "";
    expect(await rejects(changes.decide(first.id, fingerprint, true, "可以"))).toMatchObject({
      code: "APPROVAL_REASON",
    });
    for (const reason of ["", " ", "a".repeat(201), `第一行${char(10)}第二行`, `x${char(0x7f)}`])
      await rejects(changes.decide(first.id, fingerprint, false, reason));
    expect(changes.poll(first.id).change.state).toBe("pending");
    expect(changes.poll(first.id).change).not.toHaveProperty("denial_reason");
    // The fingerprint is unchanged by a reason: a wrong one still fails.
    expect(await rejects(changes.decide(first.id, "b".repeat(64), false, "不要"))).toMatchObject({
      code: "APPROVAL_MISMATCH",
    });

    await changes.decide(first.id, fingerprint, false, "  請改成修改既有檔案  ");
    const denied = changes.poll(first.id).change;
    expect(denied).toMatchObject({ state: "denied", denial_reason: "請改成修改既有檔案" });
    expect(changes.list().find((item) => item.id === first.id)?.denial_reason).toBe(
      "請改成修改既有檔案",
    );
    const finished = changes.approvals().find((item) => item.id === first.id);
    expect(finished).toMatchObject({
      state: "denied",
      fingerprint,
      diff: "",
      diff_available: false,
      denial_reason: "請改成修改既有檔案",
    });
    // The model-facing poll still returns its own bounded diff.
    expect(changes.poll(first.id).diff).toContain("+第二行");

    // Known credential formats never reach the model, even when the user pastes one.
    const leaked = (await request("leaked.md")).change;
    const leakedReview = changes.approvals().find((item) => item.id === leaked.id);
    const canary = `sk-proj-${"C".repeat(30)}`;
    await changes.decide(leaked.id, leakedReview?.fingerprint ?? "", false, `不要用 ${canary}`);
    expect(changes.poll(leaked.id).change.denial_reason).toBe("不要用 [OPENAI KEY REDACTED]");
    expect(JSON.stringify(changes.approvals())).not.toContain(canary);

    // Denial without a reason leaves no field behind.
    const second = (await request("second.md")).change;
    const secondReview = changes.approvals().find((item) => item.id === second.id);
    await changes.decide(second.id, secondReview?.fingerprint ?? "", false);
    expect(changes.poll(second.id).change.state).toBe("denied");
    expect(changes.poll(second.id).change).not.toHaveProperty("denial_reason");
  } finally {
    await changes.close();
  }
});

test("commands, terminals and imports return the user's denial reason to the model", async () => {
  const commands = new CommandManager(f.registry, () => undefined);
  const terminals = new TerminalManager(f.registry);
  const imports = new ArtifactImportManager(
    f.registry,
    () => {},
    async () => Buffer.from(onePixelPng),
  );
  try {
    const command = (
      await commands.request(
        {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          cwd: "",
          argv: ["bun", "-e", "console.log('never runs')"],
          timeout_ms: 5000,
        },
        "mcp",
      )
    ).command;
    const commandReview = commands.approvals().find((item) => item.id === command.id);
    expect(
      await rejects(commands.decide(command.id, commandReview?.fingerprint ?? "", true, "好")),
    ).toMatchObject({ code: "APPROVAL_REASON" });
    expect((await commands.poll(command.id, 0, 0)).command.state).toBe("pending");
    await commands.decide(command.id, commandReview?.fingerprint ?? "", false, "先跑單元測試");
    const polled = await commands.poll(command.id, 0, 0);
    expect(polled.command).toMatchObject({ state: "denied", denial_reason: "先跑單元測試" });
    expect(polled.stdout).toBe("");
    expect(commands.list()[0]?.denial_reason).toBe("先跑單元測試");

    if (terminals.available) {
      const session = (
        await terminals.request(
          {
            workspace_id: f.workspace.id,
            cwd: "",
            shell: process.platform === "win32" ? "cmd" : "sh",
            cols: 80,
            rows: 24,
          },
          "mcp",
        )
      ).session;
      const sessionReview = terminals.approvals().find((item) => item.id === session.id);
      expect(
        await rejects(terminals.decide(session.id, sessionReview?.fingerprint ?? "", true, "好")),
      ).toMatchObject({ code: "APPROVAL_REASON" });
      expect((await terminals.poll(session.id, 0)).session.state).toBe("pending");
      await terminals.decide(session.id, sessionReview?.fingerprint ?? "", false, "用一次性命令");
      expect((await terminals.poll(session.id, 0)).session).toMatchObject({
        state: "denied",
        denial_reason: "用一次性命令",
      });
      expect(terminals.list()[0]?.denial_reason).toBe("用一次性命令");
    }

    const pending = (
      await imports.request(
        {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          path: "generated.png",
          summary: "保存圖片",
          file: { download_url: "https://files.example/signed", file_id: "file_fixture" },
        },
        "mcp",
      )
    ).artifact_import;
    const importReview = imports.approvals().find((item) => item.id === pending.id);
    expect(
      await rejects(imports.decide(pending.id, importReview?.fingerprint ?? "", true, "好")),
    ).toMatchObject({ code: "APPROVAL_REASON" });
    await imports.decide(pending.id, importReview?.fingerprint ?? "", false, "  換一張  ");
    expect(imports.poll(pending.id).artifact_import).toMatchObject({
      state: "denied",
      denial_reason: "換一張",
    });
  } finally {
    await imports.close();
    await terminals.close();
    await commands.close();
  }
});

test("process output wakes activity observers but not the trusted panel", async () => {
  const store = new ActivityStore();
  let all = 0;
  let panel = 0;
  store.subscribe(() => all++);
  const unsubscribe = store.subscribe(() => panel++, { processIo: false });
  const session = {
    id: crypto.randomUUID(),
    workspace_id: f.workspace.id,
    cwd: "",
    shell: "bash",
    mode: "host-pty",
    state: "running",
    created_at: 1,
    expires_at: 2,
    cols: 80,
    rows: 24,
    exit_code: null,
  } satisfies TerminalSession;
  const command = {
    id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    workspace_id: f.workspace.id,
    cwd: "",
    argv: ["bun"],
    timeout_ms: 1000,
    state: "running",
    created_at: 1,
    started_at: 1,
    ended_at: null,
    expires_at: 2,
    exit_code: null,
    signal: null,
    message: null,
  } satisfies Command;
  store.terminal(session, "mcp", "state");
  store.terminal(session, "mcp", "output");
  store.terminal(session, "local-ui", "input");
  store.command(command, "mcp", "state");
  store.command(command, "mcp", "output");
  store.fileChange(
    {
      id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      workspace_id: f.workspace.id,
      summary: "變更",
      state: "pending",
      created_at: 1,
      applied_at: null,
      expires_at: 2,
      message: null,
      files: [],
    },
    "mcp",
  );
  store.artifactImport({ id: crypto.randomUUID(), state: "pending" } as ArtifactImport, "mcp");
  store.changed();
  store.finish(store.start("file_read", {}, "mcp"));
  // Ten publications; only the two terminal I/O and one command output skip the panel.
  expect([all, panel]).toEqual([10, 7]);
  unsubscribe();
  store.changed();
  expect([all, panel]).toEqual([11, 7]);
  store.close();

  // The command manager tags stdout and stderr chunks as output, never as state.
  const notices: [Command["state"], "state" | "output"][] = [];
  const commands = new CommandManager(
    f.registry,
    () => undefined,
    (view, _source, kind) => notices.push([view.state, kind]),
  );
  try {
    const pending = (
      await commands.request(
        {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          cwd: "",
          argv: ["bun", "-e", "console.log('out'); console.error('err')"],
          timeout_ms: 10_000,
        },
        "mcp",
      )
    ).command;
    const review = commands.approvals().find((item) => item.id === pending.id);
    await commands.decide(pending.id, review?.fingerprint ?? "", true);
    const deadline = Date.now() + 10_000;
    while ((await commands.poll(pending.id, 0, 0)).command.state !== "succeeded") {
      if (Date.now() >= deadline) throw new Error("Command did not finish");
      await Bun.sleep(20);
    }
    const result = await commands.poll(pending.id, 0, 0);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
    expect(notices.some(([, kind]) => kind === "output")).toBe(true);
    const states = notices.filter(([, kind]) => kind === "state").map(([state]) => state);
    expect(states[0]).toBe("pending");
    expect(states.at(-1)).toBe("succeeded");
  } finally {
    await commands.close();
  }
}, 20_000);
