import { expect, test } from "bun:test";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIAGNOSTIC_CHECK_IDS,
  type DiagnosticCheck,
  diagnosticSummary,
  VERSION,
} from "@kairomes/protocol";
import { fixture } from "../../../tests/fixtures.ts";
import { collectDiagnostics, probeWorkbench } from "./diagnostics.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";
const none = () => null;
const byId = (checks: DiagnosticCheck[]) =>
  Object.fromEntries(checks.map((check) => [check.id, check]));

test("a missing data directory is reported without being created", async () => {
  const f = await fixture();
  try {
    const missing = path.join(f.directory, "not-yet");
    const checks = await collectDiagnostics({ dataDirectory: missing, which: none });
    expect(checks.map((check) => check.id)).toEqual([...DIAGNOSTIC_CHECK_IDS]);
    expect(byId(checks)).toMatchObject({
      data_dir: { state: "warn", code: "data_dir_missing" },
      companion: { state: "warn", code: "companion_unavailable", fix: "restart_runtime" },
      workbench: { state: "warn", code: "workbench_unavailable" },
      tunnel_client: { state: "warn", code: "tunnel_client_missing", fix: "show_tunnel_help" },
      tunnel: { state: "unknown", code: "tunnel_unknown" },
      codex_cli: { state: "warn", code: "codex_cli_missing", fix: "show_codex_help" },
      mcp_config: { state: "ok", code: "mcp_config_absent", count: 0 },
      workspaces: { state: "warn", code: "workspaces_none", fix: "add_workspace" },
    });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const file = path.join(f.directory, "plain-file");
    await writeFile(file, "x");
    const invalid = byId(await collectDiagnostics({ dataDirectory: file, which: none }));
    expect(invalid.data_dir).toMatchObject({ state: "error", code: "data_dir_invalid" });
    expect(invalid.mcp_config).toMatchObject({ state: "unknown" });
    expect(invalid.workspaces).toMatchObject({ state: "unknown", code: "workspaces_unknown" });
  } finally {
    await f.dispose();
  }
});

test("MCP config reports only server or issue counts and never connects", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.state, "mcp-servers.json");
    const check = async () =>
      byId(await collectDiagnostics({ dataDirectory: f.state, registry: f.registry, which: none }))
        .mcp_config;
    expect(await check()).toEqual({
      id: "mcp_config",
      state: "ok",
      code: "mcp_config_absent",
      count: 0,
    });
    await writeFile(file, JSON.stringify({ version: 1, servers: [] }));
    expect(await check()).toMatchObject({ state: "ok", code: "mcp_config_ok", count: 0 });
    await writeFile(file, "{ not json, C:\\\\Users\\\\secret");
    expect(await check()).toEqual({
      id: "mcp_config",
      state: "error",
      code: "mcp_config_invalid",
      count: 1,
      fix: "review_mcp_config",
    });
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        servers: [{ id: "x", command: "/home/me/secret-server" }],
        x: 1,
      }),
    );
    const invalid = await check();
    expect(invalid).toMatchObject({ state: "error", code: "mcp_config_invalid" });
    expect(invalid?.count).toBeGreaterThan(1);
    expect(JSON.stringify(invalid)).not.toContain("secret");
    await writeFile(file, "x".repeat(1024 * 1024 + 1));
    expect(await check()).toMatchObject({ state: "error", code: "mcp_config_unreadable" });
  } finally {
    await f.dispose();
  }
});

test("MCP config counts stored relative working directories without exposing them", async () => {
  const f = await fixture();
  try {
    const server = (cwd?: string) => ({
      id: crypto.randomUUID(),
      name: "合成服務",
      transport: {
        kind: "stdio",
        command: "/home/me/secret-server",
        ...(cwd === undefined ? {} : { cwd }),
      },
    });
    const write = (servers: unknown[]) =>
      writeFile(path.join(f.state, "mcp-servers.json"), JSON.stringify({ version: 1, servers }));
    const check = async () =>
      byId(await collectDiagnostics({ dataDirectory: f.state, registry: f.registry, which: none }))
        .mcp_config;
    await write([server(), server(f.root)]);
    expect(await check()).toEqual({
      id: "mcp_config",
      state: "ok",
      code: "mcp_config_ok",
      count: 2,
    });
    await write([server("secret-project"), server(f.root), server("./secret-other")]);
    const relative = await check();
    expect(relative).toEqual({
      id: "mcp_config",
      state: "warn",
      code: "mcp_config_cwd_relative",
      count: 2,
      fix: "review_mcp_config",
    });
    expect(JSON.stringify(relative)).not.toContain("secret");
    expect(diagnosticSummary([relative as DiagnosticCheck], VERSION)).toContain(
      "mcp_config: warn mcp_config_cwd_relative count=2 fix=review_mcp_config",
    );
  } finally {
    await f.dispose();
  }
});

test("workspace check counts missing or replaced roots without exposing them", async () => {
  const f = await fixture();
  try {
    const check = async () =>
      byId(await collectDiagnostics({ dataDirectory: f.state, which: none })).workspaces;
    expect(await check()).toEqual({
      id: "workspaces",
      state: "ok",
      code: "workspaces_ok",
      count: 1,
    });
    const otherRoot = path.join(f.directory, "other");
    await mkdir(otherRoot);
    await f.registry.add(otherRoot, "其他");
    await rm(otherRoot, { recursive: true });
    await rename(f.root, `${f.root}-old`);
    await mkdir(f.root);
    const result = await check();
    expect(result).toEqual({
      id: "workspaces",
      state: "warn",
      code: "workspaces_unavailable",
      count: 2,
      fix: "review_workspaces",
    });
    expect(JSON.stringify(result)).not.toContain(f.directory);
  } finally {
    await f.dispose();
  }
});

test("process checks map live state to fixed codes, versions and one fix", async () => {
  const f = await fixture();
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    expect(await probeWorkbench(f.state)).toEqual({ state: "running", version: VERSION });
    const which = (command: string) =>
      ["tunnel-client", "codex"].includes(command) ? `/opt/${command}` : null;
    const checks = await collectDiagnostics({
      dataDirectory: f.state,
      registry: f.registry,
      which,
      companion: { state: "running", version: VERSION },
      tunnel: { state: "error", reason: "auth", nextRetryAt: null },
    });
    expect(byId(checks)).toMatchObject({
      data_dir: { state: "ok", code: "data_dir_ok" },
      companion: { state: "ok", code: "companion_running", version: VERSION },
      workbench: { state: "ok", code: "workbench_running", version: VERSION },
      tunnel_client: { state: "ok", code: "tunnel_client_found" },
      tunnel: { state: "error", code: "tunnel_failed", reason: "auth", fix: "configure_key" },
      codex_cli: { state: "ok", code: "codex_cli_found" },
    });

    const skewed = byId(
      await collectDiagnostics({
        dataDirectory: f.state,
        registry: f.registry,
        which,
        expectedVersion: "9.9.9",
        companion: { state: "running", version: null },
        workbench: { state: "external", version: "0.1.4" },
        tunnel: { state: "error", reason: "network", nextRetryAt: new Date().toISOString() },
      }),
    );
    expect(skewed.companion).toEqual({
      id: "companion",
      state: "warn",
      code: "companion_version_mismatch",
      fix: "restart_runtime",
    });
    expect(skewed.workbench).toEqual({
      id: "workbench",
      state: "warn",
      code: "workbench_version_mismatch",
      fix: "retry_workbench",
      version: "0.1.4",
    });
    expect(skewed.tunnel).toEqual({
      id: "tunnel",
      state: "warn",
      code: "tunnel_retrying",
      reason: "network",
    });
    const states = async (
      tunnel: Parameters<typeof collectDiagnostics>[0]["tunnel"],
      workbench: Parameters<typeof collectDiagnostics>[0]["workbench"],
    ) => {
      const result = byId(
        await collectDiagnostics({
          dataDirectory: f.state,
          registry: f.registry,
          which,
          tunnel,
          workbench,
        }),
      );
      return [result.tunnel, result.workbench];
    };
    expect(
      await states(
        { state: "missing", reason: null, nextRetryAt: null },
        { state: "error", version: null },
      ),
    ).toMatchObject([
      { state: "error", code: "tunnel_failed", reason: "not_installed", fix: "show_tunnel_help" },
      { state: "error", code: "workbench_error", fix: "retry_workbench" },
    ]);
    expect(
      await states(
        { state: "stopped", reason: null, nextRetryAt: null },
        { state: "starting", version: null },
      ),
    ).toMatchObject([
      { state: "warn", code: "tunnel_stopped", fix: "start_tunnel" },
      { state: "warn", code: "workbench_starting" },
    ]);

    const connection = await readWorkbenchConnection(f.state);
    const text = JSON.stringify(checks) + diagnosticSummary(checks, VERSION);
    for (const secret of [
      f.root,
      f.state,
      f.directory,
      connection.origin,
      connection.uiToken,
      connection.adminToken,
      connection.mcpToken,
      "/opt/",
    ])
      expect(text).not.toContain(secret);
  } finally {
    await app.close();
    await f.dispose();
  }
  expect(await probeWorkbench(f.state)).toEqual({ state: "unavailable", version: null });
});
