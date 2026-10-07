import { expect, test } from "bun:test";
import { PERMANENT_TUNNEL_REASONS, parseVersion, TUNNEL_REASONS } from "./companion.ts";
import {
  DIAGNOSTIC_FIXES,
  type DiagnosticCheck,
  diagnosticSummary,
  tunnelFix,
} from "./diagnostics.ts";

test("parseVersion accepts only plain semantic versions", () => {
  for (const valid of ["0.2.0", "10.20.300", "0.3.0-beta.1"])
    expect(parseVersion(valid)).toBe(valid);
  for (const invalid of [
    undefined,
    null,
    2,
    "",
    "v0.2.0",
    "0.2",
    "0.2.0 ",
    "0.2.0\nfix=configure_key",
    `0.2.0-${"x".repeat(40)}`,
    "http://127.0.0.1:4318/#session=abc",
    "C:\\Users\\me\\project",
  ])
    expect(parseVersion(invalid)).toBeNull();
});

test("every Tunnel reason maps to one listed recovery action", () => {
  for (const reason of TUNNEL_REASONS) expect(DIAGNOSTIC_FIXES).toContain(tunnelFix(reason));
  expect(tunnelFix("auth")).toBe("configure_key");
  expect(tunnelFix("profile_missing")).toBe("show_profile_setup");
  expect(tunnelFix("not_installed")).toBe("show_tunnel_help");
  expect([...PERMANENT_TUNNEL_REASONS].sort()).toEqual([
    "auth",
    "not_installed",
    "profile_missing",
  ]);
});

test("diagnostic summary is plain text with enums, counts and versions only", () => {
  const checks: DiagnosticCheck[] = [
    { id: "data_dir", state: "ok", code: "data_dir_ok" },
    { id: "workbench", state: "warn", code: "workbench_version_mismatch", version: "0.1.4" },
    { id: "tunnel", state: "error", code: "tunnel_failed", reason: "auth", fix: "configure_key" },
    { id: "mcp_config", state: "error", code: "mcp_config_invalid", count: 3 },
  ];
  expect(diagnosticSummary(checks, "0.2.0")).toBe(
    [
      "Kairomes 0.2.0 診斷摘要",
      "data_dir: ok data_dir_ok",
      "workbench: warn workbench_version_mismatch version=0.1.4",
      "tunnel: error tunnel_failed reason=auth fix=configure_key",
      "mcp_config: error mcp_config_invalid count=3",
    ].join("\n"),
  );
});

test("diagnostic summary drops anything that is not a known enum, count or version", () => {
  const secrets = [
    "C:\\Users\\me\\private-project",
    "/home/me/private-project",
    "http://127.0.0.1:4318/#session=0123456789abcdef",
    "a".repeat(64),
    "CONTROL_PLANE_API_KEY=sk-test",
  ];
  const hostile = secrets.map(
    (secret) =>
      ({
        id: "workbench",
        state: secret,
        code: secret,
        fix: secret,
        reason: secret,
        version: secret,
        count: secret,
      }) as unknown as DiagnosticCheck,
  );
  hostile.push({ id: secrets[0], state: "ok", code: "data_dir_ok" } as unknown as DiagnosticCheck);
  hostile.push({ id: "workspaces", state: "ok", code: "workspaces_ok", count: -1 });
  hostile.push({ id: "workspaces", state: "ok", code: "workspaces_ok", count: 1.5 });
  const summary = diagnosticSummary(hostile, secrets[2] ?? "");
  for (const secret of secrets) expect(summary).not.toContain(secret);
  expect(summary).not.toContain("count=");
  expect(summary.split("\n")[0]).toBe("Kairomes unknown 診斷摘要");
  expect(summary).toContain("workbench: unknown unknown");
  expect(summary).not.toContain("private-project");
});
