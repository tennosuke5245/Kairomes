import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type CompanionTunnelState,
  type CompanionWorkbenchState,
  type DiagnosticCheck,
  McpMountFileSchema,
  type TunnelReason,
  tunnelFix,
  VERSION,
} from "@kairomes/protocol";
import { resolveChecked, WorkspaceRegistry } from "@kairomes/workspace-core";
import { isAbsoluteLaunchDirectory } from "./mcp-launch.ts";
import { readWorkbenchConnection, verifyWorkbenchConnection } from "./workbench-connection.ts";

const MCP_CONFIG_FILE = "mcp-servers.json";
/** McpHostManager allows 16 servers with bounded fields; anything this large is not a config. */
const MCP_CONFIG_MAX_BYTES = 1024 * 1024;

export type WorkbenchProbe = {
  state: CompanionWorkbenchState | "unavailable";
  version: string | null;
};
export type CompanionProbe = { state: "running" | "unavailable"; version: string | null };
export type TunnelProbe = {
  state: CompanionTunnelState;
  reason: TunnelReason | null;
  nextRetryAt: string | null;
};

export type DiagnosticOptions = {
  dataDirectory: string;
  /** Live workbench state; probed from the published descriptor when omitted. */
  workbench?: WorkbenchProbe;
  /** Live Companion state; reported as unavailable when omitted. */
  companion?: CompanionProbe;
  /** Live Tunnel state; only the Companion supervises it, so it is unknown when omitted. */
  tunnel?: TunnelProbe;
  /** An open registry to reuse; otherwise one is opened and closed for this check. */
  registry?: WorkspaceRegistry;
  /** PATH lookup, injectable for tests. */
  which?: (command: string) => string | null;
  expectedVersion?: string;
};

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

/** Reads the published workbench descriptor and its /healthz; never returns tokens or URLs. */
export async function probeWorkbench(dataDirectory: string): Promise<WorkbenchProbe> {
  try {
    const health = await verifyWorkbenchConnection(await readWorkbenchConnection(dataDirectory));
    return { state: "running", version: health.version };
  } catch {
    return { state: "unavailable", version: null };
  }
}

async function dataDirectoryCheck(directory: string): Promise<DiagnosticCheck> {
  try {
    if (!(await stat(directory)).isDirectory())
      return { id: "data_dir", state: "error", code: "data_dir_invalid" };
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { id: "data_dir", state: "warn", code: "data_dir_missing" }
      : { id: "data_dir", state: "error", code: "data_dir_invalid" };
  }
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return { id: "data_dir", state: "ok", code: "data_dir_ok" };
  } catch {
    return { id: "data_dir", state: "error", code: "data_dir_unwritable" };
  }
}

function companionCheck(probe: CompanionProbe | undefined, expected: string): DiagnosticCheck {
  if (probe?.state !== "running")
    return {
      id: "companion",
      state: "warn",
      code: "companion_unavailable",
      fix: "restart_runtime",
    };
  const version = probe.version ?? undefined;
  return probe.version === expected
    ? { id: "companion", state: "ok", code: "companion_running", version }
    : {
        id: "companion",
        state: "warn",
        code: "companion_version_mismatch",
        fix: "restart_runtime",
        ...(version ? { version } : {}),
      };
}

function workbenchCheck(probe: WorkbenchProbe, expected: string): DiagnosticCheck {
  const version = probe.version ?? undefined;
  if (probe.state === "running" || probe.state === "external") {
    if (probe.version !== expected)
      return {
        id: "workbench",
        state: "warn",
        code: "workbench_version_mismatch",
        fix: probe.state === "external" ? "retry_workbench" : "restart_runtime",
        ...(version ? { version } : {}),
      };
    return {
      id: "workbench",
      state: "ok",
      code: probe.state === "external" ? "workbench_external" : "workbench_running",
      ...(version ? { version } : {}),
    };
  }
  if (probe.state === "starting")
    return { id: "workbench", state: "warn", code: "workbench_starting" };
  if (probe.state === "unavailable")
    return {
      id: "workbench",
      state: "warn",
      code: "workbench_unavailable",
      fix: "restart_runtime",
    };
  return {
    id: "workbench",
    state: "error",
    code: probe.state === "stopped" ? "workbench_stopped" : "workbench_error",
    fix: "retry_workbench",
  };
}

function tunnelCheck(probe: TunnelProbe | undefined): DiagnosticCheck {
  if (!probe) return { id: "tunnel", state: "unknown", code: "tunnel_unknown" };
  if (probe.state === "running") return { id: "tunnel", state: "ok", code: "tunnel_running" };
  if (probe.state === "starting") return { id: "tunnel", state: "warn", code: "tunnel_starting" };
  if (probe.state === "stopped")
    return { id: "tunnel", state: "warn", code: "tunnel_stopped", fix: "start_tunnel" };
  const reason = probe.reason ?? (probe.state === "missing" ? "not_installed" : "unknown");
  if (probe.nextRetryAt) return { id: "tunnel", state: "warn", code: "tunnel_retrying", reason };
  return { id: "tunnel", state: "error", code: "tunnel_failed", reason, fix: tunnelFix(reason) };
}

/**
 * Parses mcp-servers.json the same way McpHostManager does, without connecting to or spawning
 * any server. Reports only counts: servers when valid, schema issues when invalid, and stdio
 * servers whose stored working directory must become absolute.
 */
async function mcpConfigCheck(directory: string): Promise<DiagnosticCheck> {
  const file = path.join(directory, MCP_CONFIG_FILE);
  let source: string;
  try {
    // Follows links like McpHostManager does, but refuses special or oversized files.
    const info = await stat(file);
    if (!info.isFile() || info.size > MCP_CONFIG_MAX_BYTES)
      return { id: "mcp_config", state: "error", code: "mcp_config_unreadable" };
    source = await readFile(file, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { id: "mcp_config", state: "ok", code: "mcp_config_absent", count: 0 }
      : { id: "mcp_config", state: "error", code: "mcp_config_unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      id: "mcp_config",
      state: "error",
      code: "mcp_config_invalid",
      count: 1,
      fix: "review_mcp_config",
    };
  }
  const result = McpMountFileSchema.safeParse(parsed);
  if (!result.success)
    return {
      id: "mcp_config",
      state: "error",
      code: "mcp_config_invalid",
      count: result.error.issues.length,
      fix: "review_mcp_config",
    };
  // A stored relative working directory is no longer resolved against the Host's; it is not started.
  const relative = result.data.servers.filter(
    ({ transport }) =>
      transport.kind === "stdio" &&
      transport.cwd !== undefined &&
      !isAbsoluteLaunchDirectory(transport.cwd),
  ).length;
  return relative
    ? {
        id: "mcp_config",
        state: "warn",
        code: "mcp_config_cwd_relative",
        count: relative,
        fix: "review_mcp_config",
      }
    : { id: "mcp_config", state: "ok", code: "mcp_config_ok", count: result.data.servers.length };
}

/** Counts mounted roots that are missing or replaced, using the same check as every file read. */
async function workspacesCheck(registry: WorkspaceRegistry): Promise<DiagnosticCheck> {
  const workspaces = registry.list();
  if (workspaces.length === 0)
    return { id: "workspaces", state: "warn", code: "workspaces_none", fix: "add_workspace" };
  let unavailable = 0;
  for (const workspace of workspaces) {
    try {
      await resolveChecked(registry.get(workspace.id), "");
    } catch {
      unavailable++;
    }
  }
  return unavailable
    ? {
        id: "workspaces",
        state: "warn",
        code: "workspaces_unavailable",
        count: unavailable,
        fix: "review_workspaces",
      }
    : { id: "workspaces", state: "ok", code: "workspaces_ok", count: workspaces.length };
}

/**
 * Fixed-id local checks in a fixed order. Every field is an enum, a count or a version; no
 * check reads workspace content, runs a configured MCP server or returns a path, URL or token.
 */
export async function collectDiagnostics(options: DiagnosticOptions): Promise<DiagnosticCheck[]> {
  const expected = options.expectedVersion ?? VERSION;
  const which = options.which ?? ((command: string) => Bun.which(command));
  const dataDirectory = await dataDirectoryCheck(options.dataDirectory);
  const checks: DiagnosticCheck[] = [
    dataDirectory,
    companionCheck(options.companion, expected),
    workbenchCheck(options.workbench ?? (await probeWorkbench(options.dataDirectory)), expected),
  ];
  checks.push(
    which("tunnel-client")
      ? { id: "tunnel_client", state: "ok", code: "tunnel_client_found" }
      : {
          id: "tunnel_client",
          state: "warn",
          code: "tunnel_client_missing",
          fix: "show_tunnel_help",
        },
  );
  checks.push(tunnelCheck(options.tunnel));
  checks.push(
    (which("codex.exe") ?? which("codex"))
      ? { id: "codex_cli", state: "ok", code: "codex_cli_found" }
      : { id: "codex_cli", state: "warn", code: "codex_cli_missing", fix: "show_codex_help" },
  );
  // A data directory that does not exist yet simply has no configuration and no projects.
  const missing = dataDirectory.code === "data_dir_missing";
  const readable =
    dataDirectory.code === "data_dir_ok" || dataDirectory.code === "data_dir_unwritable";
  checks.push(
    missing
      ? { id: "mcp_config", state: "ok", code: "mcp_config_absent", count: 0 }
      : readable
        ? await mcpConfigCheck(options.dataDirectory)
        : { id: "mcp_config", state: "unknown", code: "mcp_config_unreadable" },
  );
  let workspaces: DiagnosticCheck = missing
    ? { id: "workspaces", state: "warn", code: "workspaces_none", fix: "add_workspace" }
    : { id: "workspaces", state: "unknown", code: "workspaces_unknown" };
  if (options.registry) workspaces = await workspacesCheck(options.registry);
  else if (readable) {
    try {
      const registry = await WorkspaceRegistry.open(options.dataDirectory);
      try {
        workspaces = await workspacesCheck(registry);
      } finally {
        registry.close();
      }
    } catch {
      // A newer, damaged or read-only state database stays unknown; workbench startup reports it.
    }
  }
  checks.push(workspaces);
  return checks;
}
