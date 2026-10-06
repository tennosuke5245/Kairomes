import { describe, expect, test } from "bun:test";
import type { ActivityEntry } from "./activity.ts";
import type { ArtifactImport } from "./artifact-import.ts";
import type { Command } from "./command.ts";
import type { FileChange } from "./file-change.ts";
import type { TerminalSession } from "./index.ts";
import type { McpServerSummary } from "./mcp-host.ts";
import { dataToneFor, iconSpriteId, toneFor, type UiStateKind, type UiTone } from "./ui-state.ts";

// Every protocol state per kind, so a new enum value fails here until it gets a row.
const commandStates: Command["state"][] = [
  "pending",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "denied",
  "expired",
];
const terminalStates: TerminalSession["state"][] = [
  "pending",
  "starting",
  "running",
  "exited",
  "denied",
  "stopped",
  "expired",
  "failed",
];
const changeStates: FileChange["state"][] = [
  "pending",
  "applying",
  "applied",
  "denied",
  "cancelled",
  "expired",
  "conflict",
  "failed",
];
const importStates: ArtifactImport["state"][] = changeStates;
const mcpStates: McpServerSummary["state"][] = [
  "disconnected",
  "connecting",
  "ready",
  "unavailable",
];

const tones = (kind: UiStateKind, states: readonly string[]) =>
  Object.fromEntries(states.map((state) => [state, toneFor(kind, state).tone]));

describe("toneFor", () => {
  test("commands follow the semantic table", () => {
    expect(tones("command", commandStates)).toEqual({
      pending: "attention",
      starting: "running",
      running: "running",
      succeeded: "success",
      failed: "danger",
      timed_out: "danger",
      cancelled: "neutral",
      denied: "neutral",
      expired: "neutral",
    } satisfies Record<Command["state"], UiTone>);
    expect(toneFor("command", "pending")).toEqual({
      tone: "attention",
      dataTone: "brand",
      icon: "Tray",
      label: "需確認",
      spin: false,
    });
    expect(toneFor("command", "running")).toMatchObject({ icon: "CircleNotch", spin: true });
    expect(toneFor("command", "timed_out").label).toBe("逾時");
  });

  test("exit 0 is a finished run result, never a verification claim", () => {
    const success = toneFor("command", "succeeded");
    expect(success).toMatchObject({ tone: "success", icon: "Check", label: "已完成" });
    for (const kind of ["command", "terminal", "file_change", "artifact_import", "tool"] as const)
      for (const state of [...commandStates, ...terminalStates, ...changeStates, "completed"])
        expect(toneFor(kind, state).label).not.toMatch(/驗證|安全|沙箱/);
  });

  test("an open terminal accepts input and has one tone everywhere", () => {
    expect(tones("terminal", terminalStates)).toEqual({
      pending: "attention",
      starting: "running",
      running: "running",
      exited: "neutral",
      denied: "neutral",
      stopped: "neutral",
      expired: "neutral",
      failed: "danger",
    } satisfies Record<TerminalSession["state"], UiTone>);
    expect(toneFor("terminal", "running")).toMatchObject({
      icon: "TerminalWindow",
      label: "可接收輸入",
      spin: false,
    });
    expect(toneFor("terminal", "exited").label).toBe("已結束");
  });

  test("file changes and artifact imports share one table", () => {
    const expected = {
      pending: "attention",
      applying: "running",
      applied: "success",
      denied: "neutral",
      cancelled: "neutral",
      expired: "neutral",
      conflict: "danger",
      failed: "danger",
    } satisfies Record<FileChange["state"], UiTone>;
    expect(tones("file_change", changeStates)).toEqual(expected);
    expect(tones("artifact_import", importStates)).toEqual(expected);
    expect(toneFor("file_change", "conflict").label).toBe("版本衝突");
    expect(toneFor("file_change", "applied").label).toBe("已套用");
  });

  test("activity entries map directly from their kind and state", () => {
    const entry = (kind: ActivityEntry["kind"], state: ActivityEntry["state"]) =>
      toneFor(kind, state).tone;
    expect(entry("tool", "working")).toBe("running");
    expect(entry("tool", "completed")).toBe("success");
    expect(entry("tool", "failed")).toBe("danger");
    expect(entry("command", "working")).toBe("running");
    expect(entry("terminal", "running")).toBe("running");
    expect(entry("file_change", "pending")).toBe("attention");
  });

  test("MCP servers and logins", () => {
    expect(tones("mcp_server", mcpStates)).toEqual({
      disconnected: "neutral",
      connecting: "running",
      ready: "success",
      unavailable: "danger",
    } satisfies Record<McpServerSummary["state"], UiTone>);
    expect(toneFor("mcp_server", "needs_login")).toMatchObject({
      tone: "warning",
      icon: "SignIn",
      label: "需要登入",
    });
    expect(toneFor("mcp_server", "unavailable").label).toBe("啟動失敗");
    expect(toneFor("mcp_auth", "authenticated").tone).toBe("success");
    expect(toneFor("mcp_auth", "verifying")).toMatchObject({ tone: "running", spin: true });
    expect(toneFor("mcp_auth", "pending")).toMatchObject({
      tone: "warning",
      label: "登入狀態待確認",
    });
  });

  test("access modes and the panel connection", () => {
    expect(toneFor("access", "step")).toMatchObject({ tone: "neutral", label: "逐步確認" });
    expect(toneFor("access", "files")).toMatchObject({ tone: "warning", label: "檔案自主" });
    expect(toneFor("access", "full")).toMatchObject({ tone: "warning", icon: "Lightning" });
    expect(toneFor("access", "auto")).toEqual(toneFor("access", "full"));
    // An unreadable grant is unconfirmed, never quietly "step".
    expect(toneFor("access", "succeeded")).toMatchObject({
      tone: "warning",
      label: "權限待確認",
    });
    expect(toneFor("connection", "offline")).toMatchObject({ tone: "danger" });
    expect(toneFor("connection", "reconnecting").tone).toBe("running");
  });

  test("unknown, uncertain and stale states are warnings, never success", () => {
    for (const kind of [
      "command",
      "terminal",
      "file_change",
      "artifact_import",
      "tool",
      "mcp_server",
      "connection",
    ] as const) {
      for (const state of ["unknown", "uncertain", "", "constructor", "__proto__", "SUCCEEDED"])
        expect(toneFor(kind, state)).toMatchObject({
          tone: "warning",
          dataTone: "warning",
          icon: "Question",
          label: "結果待確認",
        });
      expect(toneFor(kind, "stale")).toMatchObject({
        tone: "warning",
        icon: "ArrowsClockwise",
        label: "內容可能已過時",
      });
    }
  });
});

test("data tones match the [data-tone] values in @kairomes/ui-tokens", async () => {
  const css = await Bun.file(new URL("../../ui-tokens/tokens.css", import.meta.url)).text();
  const declared = new Set([...css.matchAll(/\[data-tone="([a-z]+)"\]/g)].map((match) => match[1]));
  for (const tone of ["attention", "running", "success", "warning", "danger", "neutral"] as const)
    expect(declared.has(dataToneFor(tone))).toBe(true);
  expect(dataToneFor("attention")).toBe("brand");
});

test("sprite ids are kebab-case Phosphor names", () => {
  expect(iconSpriteId("CircleNotch")).toBe("ph-circle-notch");
  expect(iconSpriteId("XCircle")).toBe("ph-x-circle");
  expect(iconSpriteId("SignIn")).toBe("ph-sign-in");
  expect(iconSpriteId("Tray")).toBe("ph-tray");
});
