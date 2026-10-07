import { expect, test } from "bun:test";
import {
  classifyTunnelLine,
  nextTunnelRestartDelay,
  strongerReason,
  TUNNEL_RESTART_DELAYS_MS,
  TUNNEL_RESTART_WINDOW_MS,
  TUNNEL_STARTUP_MS,
  TUNNEL_TAIL_LINES,
  TUNNEL_TAIL_MS,
  TunnelRunLog,
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
    ["Error: API key is invalid", "auth"],
    // Structured entries count only their message and error fields, never attribute keys.
    [
      JSON.stringify({
        level: "error",
        msg: "start failed",
        error: { message: "unknown profile" },
      }),
      "profile_missing",
    ],
    ['level=error profile=kairomes msg="profile not found"', "profile_missing"],
    ['level=warn profile=kairomes msg="stream reset" err="connection reset by peer"', "network"],
    // INFO entries and ordinary output are never classified, even with alarming words.
    [JSON.stringify({ level: "INFO", msg: "retrying after 401 Unauthorized" }), undefined],
    ['level=info msg="retrying after 401 Unauthorized"', undefined],
    ["Tunnel connected; serving MCP over stdio", undefined],
    ["OnStop hook 3", undefined],
    ["", undefined],
    // A logger's profile attribute next to an unrelated message is not a missing profile.
    [
      JSON.stringify({
        level: "WARN",
        profile: "kairomes",
        msg: "MCP session not found; client will reinitialize",
      }),
      undefined,
    ],
    [
      JSON.stringify({ level: "ERROR", profile: "kairomes", msg: "upstream unknown error" }),
      undefined,
    ],
    [JSON.stringify({ level: "ERROR", unauthorized: true, msg: "request stats" }), undefined],
    ["WARN loaded profile kairomes; unknown flag --foo ignored", undefined],
    ['level=warn profile=kairomes msg="tool call missing argument"', undefined],
    [JSON.stringify({ level: "ERROR", msg: "invalid key in MCP response payload" }), undefined],
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

test("a long run is judged by its last lines, a short run by all of them", () => {
  const benign = JSON.stringify({
    level: "WARN",
    profile: "kairomes",
    msg: "MCP session not found; client will reinitialize",
  });
  const network = "dial tcp 10.0.0.1:443: connect: connection refused";
  const forbidden = JSON.stringify({ level: "warning", msg: "MCP request returned 403 Forbidden" });

  // The reviewer's run: a profile-tagged WARN, then a network failure 300 ms later.
  const short = new TunnelRunLog(0);
  short.add(benign, 10);
  short.add(network, 310);
  expect(short.reason(320)).toBe("network");
  expect(tunnelExitReason(1, short.reason(320))).toBe("network");
  expect(nextTunnelRestartDelay(tunnelExitReason(1, short.reason(320)), [], 320)).toBe(2_000);

  // A startup failure counts every line of the run, so the most actionable class wins.
  const startup = new TunnelRunLog(0);
  startup.add("ERROR: 401 Unauthorized", 100);
  startup.add(network, 200);
  expect(startup.reason(TUNNEL_STARTUP_MS - 1)).toBe("auth");

  // Hours later, an old per-request 403 no longer decides why the Tunnel exited.
  const hour = 60 * 60_000;
  const long = new TunnelRunLog(0);
  long.add(forbidden, 20_000);
  for (let line = 0; line < TUNNEL_TAIL_LINES; line++) long.add("serving MCP", hour - 10_000);
  long.add(network, hour - 100);
  expect(long.reason(hour)).toBe("network");
  // With nothing classified near the exit, the class is unknown and the restart is generic.
  const quiet = new TunnelRunLog(0);
  quiet.add(forbidden, 20_000);
  for (let line = 0; line < TUNNEL_TAIL_LINES; line++) quiet.add("serving MCP", hour - 10_000);
  expect(quiet.reason(hour)).toBeUndefined();
  expect(tunnelExitReason(1, quiet.reason(hour))).toBe("unknown");

  // A failure right before the exit still counts, by time or by being among the final lines.
  const recent = new TunnelRunLog(0);
  recent.add("ERROR: 401 Unauthorized", hour - TUNNEL_TAIL_MS);
  expect(recent.reason(hour)).toBe("auth");
  const final = new TunnelRunLog(0);
  final.add('Error: profile "kairomes" not found', hour - 60_000);
  for (let line = 1; line < TUNNEL_TAIL_LINES; line++) final.add("shutting down", hour - 60_000);
  expect(final.reason(hour)).toBe("profile_missing");
  final.add("shutting down", hour - 60_000);
  expect(final.reason(hour)).toBeUndefined();
  // Lines that arrive while the pipes drain after the exit belong to the tail.
  const drained = new TunnelRunLog(0);
  drained.add(network, hour + 200);
  expect(drained.reason(hour)).toBe("network");
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
  expect(tunnelSpawnReason(new Error("Guard: resource not found"))).toBe("unknown");
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
