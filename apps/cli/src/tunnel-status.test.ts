import { expect, test } from "bun:test";
import {
  classifyTunnelLine,
  nextTunnelRestartDelay,
  strongerReason,
  TUNNEL_RESTART_DELAYS_MS,
  TUNNEL_RESTART_WINDOW_MS,
  tunnelExitReason,
  tunnelSpawnReason,
} from "./tunnel-status.ts";

test("tunnel log lines map to a fixed failure class, or none", () => {
  const cases: [string, ReturnType<typeof classifyTunnelLine>][] = [
    ['Error: profile "kairomes" not found', "profile_missing"],
    ["no profile named kairomes", "profile_missing"],
    ["profile kairomes does not exist; run tunnel-client init", "profile_missing"],
    ["ERROR: 401 Unauthorized", "auth"],
    ["control plane rejected request: invalid api key", "auth"],
    ["CONTROL_PLANE_API_KEY is not set", "auth"],
    ["request failed with status code 403", "auth"],
    [JSON.stringify({ level: "ERROR", msg: "authentication failed" }), "auth"],
    ["WORKBENCH_UNAVAILABLE: synthetic attach failure", "workbench"],
    ["找不到有效的本機工作台連線；請先執行 bun run app", "workbench"],
    ["dial tcp 1.2.3.4:443: connect: connection refused", "network"],
    ["getaddrinfo ENOTFOUND api.example", "network"],
    [JSON.stringify({ level: "WARN", msg: "network is unreachable" }), "network"],
    // INFO entries and ordinary output are never classified, even with alarming words.
    [JSON.stringify({ level: "INFO", msg: "retrying after 401 Unauthorized" }), undefined],
    ["Tunnel connected; serving MCP over stdio", undefined],
    ["OnStop hook 3", undefined],
    ["", undefined],
  ];
  for (const [line, reason] of cases)
    expect([line, classifyTunnelLine(line)]).toEqual([line, reason]);
});

test("the most actionable class seen in a run wins", () => {
  expect(strongerReason(undefined, "network")).toBe("network");
  expect(strongerReason("network", "auth")).toBe("auth");
  expect(strongerReason("auth", "network")).toBe("auth");
  expect(strongerReason("auth", "profile_missing")).toBe("profile_missing");
  expect(strongerReason("workbench", undefined)).toBe("workbench");
});

test("exit codes and spawn errors recognise a missing client only", () => {
  expect(tunnelExitReason(127, "network")).toBe("not_installed");
  expect(tunnelExitReason(9009, undefined)).toBe("not_installed");
  expect(tunnelExitReason(1, "auth")).toBe("auth");
  expect(tunnelExitReason(1, undefined)).toBe("unknown");
  expect(tunnelExitReason(0, undefined)).toBe("unknown");
  expect(
    tunnelSpawnReason(Object.assign(new Error("posix_spawn failed"), { code: "ENOENT" })),
  ).toBe("not_installed");
  expect(tunnelSpawnReason(new Error('Executable not found in $PATH: "tunnel-client"'))).toBe(
    "not_installed",
  );
  expect(tunnelSpawnReason(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("unknown");
  expect(tunnelSpawnReason("odd")).toBe("unknown");
});

test("automatic restarts back off 2 s, 10 s, 30 s, then stop within five minutes", () => {
  expect(TUNNEL_RESTART_DELAYS_MS).toEqual([2_000, 10_000, 30_000]);
  const now = 10 * 60_000;
  expect(nextTunnelRestartDelay("network", [], now)).toBe(2_000);
  expect(nextTunnelRestartDelay("unknown", [now - 1_000], now)).toBe(10_000);
  expect(nextTunnelRestartDelay("workbench", [now - 2_000, now - 1_000], now)).toBe(30_000);
  expect(nextTunnelRestartDelay("network", [now - 3_000, now - 2_000, now - 1_000], now)).toBe(
    undefined,
  );
  // Restarts older than the window no longer count against the budget.
  const old = now - TUNNEL_RESTART_WINDOW_MS;
  expect(nextTunnelRestartDelay("network", [old - 1, old, now - 1_000], now)).toBe(10_000);
  for (const reason of ["auth", "profile_missing", "not_installed"] as const)
    expect(nextTunnelRestartDelay(reason, [], now)).toBeUndefined();
});
