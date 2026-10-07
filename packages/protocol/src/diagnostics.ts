import { parseVersion, TUNNEL_REASONS, type TunnelReason } from "./companion.ts";

/**
 * Diagnostics are fixed-id checks whose fields are enums, counts and versions only, so a copied
 * summary can be shared without leaking paths, URLs, tokens, logs or workspace content.
 */

export const DIAGNOSTIC_CHECK_IDS = [
  "data_dir",
  "companion",
  "workbench",
  "tunnel_client",
  "tunnel",
  "codex_cli",
  "mcp_config",
  "workspaces",
] as const;
export type DiagnosticCheckId = (typeof DIAGNOSTIC_CHECK_IDS)[number];

export const DIAGNOSTIC_STATES = ["ok", "warn", "error", "unknown"] as const;
export type DiagnosticState = (typeof DIAGNOSTIC_STATES)[number];

export const DIAGNOSTIC_CODES = [
  "data_dir_ok",
  "data_dir_missing",
  "data_dir_invalid",
  "data_dir_unwritable",
  "companion_running",
  "companion_unavailable",
  "companion_version_mismatch",
  "workbench_running",
  "workbench_external",
  "workbench_starting",
  "workbench_stopped",
  "workbench_error",
  "workbench_unavailable",
  "workbench_version_mismatch",
  "tunnel_client_found",
  "tunnel_client_missing",
  "tunnel_running",
  "tunnel_starting",
  "tunnel_stopped",
  "tunnel_retrying",
  "tunnel_failed",
  "tunnel_unknown",
  "codex_cli_found",
  "codex_cli_missing",
  "mcp_config_absent",
  "mcp_config_ok",
  "mcp_config_invalid",
  "mcp_config_cwd_relative",
  "mcp_config_unreadable",
  "workspaces_ok",
  "workspaces_none",
  "workspaces_unavailable",
  "workspaces_unknown",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** One suggested recovery per check. The UI maps each value to its own fixed action. */
export const DIAGNOSTIC_FIXES = [
  "restart_runtime",
  "retry_workbench",
  "start_tunnel",
  "restart_tunnel",
  "configure_key",
  "show_tunnel_help",
  "show_profile_setup",
  "show_codex_help",
  "add_workspace",
  "review_workspaces",
  "review_mcp_config",
] as const;
export type DiagnosticFix = (typeof DIAGNOSTIC_FIXES)[number];

export type DiagnosticCheck = {
  id: DiagnosticCheckId;
  state: DiagnosticState;
  code: DiagnosticCode;
  fix?: DiagnosticFix;
  /**
   * mcp_config: mounted servers when ok, schema issues when invalid, stdio servers whose stored
   * working directory is relative (and therefore not started) when cwd_relative.
   * workspaces: mounted projects when ok, unavailable projects when unavailable.
   */
  count?: number;
  /** companion and workbench: the version the process reports. */
  version?: string;
  /** tunnel: failure class when retrying or failed. */
  reason?: TunnelReason;
};

export type DiagnosticsReport = { checks: DiagnosticCheck[]; summary: string };

const TUNNEL_FIXES: Record<TunnelReason, DiagnosticFix> = {
  auth: "configure_key",
  profile_missing: "show_profile_setup",
  not_installed: "show_tunnel_help",
  network: "restart_tunnel",
  workbench: "restart_runtime",
  unknown: "restart_tunnel",
};

/** The single recovery action that matches a Tunnel failure class. */
export function tunnelFix(reason: TunnelReason): DiagnosticFix {
  return TUNNEL_FIXES[reason];
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((item) => item === value);
}

/**
 * Copyable plain-text summary. Every field is re-validated against its enum, counts must be
 * small non-negative integers and versions plain semver, so nothing else can pass through.
 */
export function diagnosticSummary(checks: readonly DiagnosticCheck[], version: string): string {
  const lines = [`Kairomes ${parseVersion(version) ?? "unknown"} 診斷摘要`];
  for (const check of checks) {
    const id = member(DIAGNOSTIC_CHECK_IDS, check.id);
    if (!id) continue;
    const parts = [
      `${id}: ${member(DIAGNOSTIC_STATES, check.state) ?? "unknown"}`,
      member(DIAGNOSTIC_CODES, check.code) ?? "unknown",
    ];
    const reason = member(TUNNEL_REASONS, check.reason);
    if (reason) parts.push(`reason=${reason}`);
    if (
      typeof check.count === "number" &&
      Number.isSafeInteger(check.count) &&
      check.count >= 0 &&
      check.count <= 1_000_000
    )
      parts.push(`count=${check.count}`);
    const checkVersion = parseVersion(check.version);
    if (checkVersion) parts.push(`version=${checkVersion}`);
    const fix = member(DIAGNOSTIC_FIXES, check.fix);
    if (fix) parts.push(`fix=${fix}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
