import { PERMANENT_TUNNEL_REASONS, type TunnelReason } from "@kairomes/protocol";

/**
 * Tunnel failure classification. Only the enum leaves this module; matched log text stays in
 * the Companion's existing redacted log tail.
 *
 * The official tunnel-client's exact wording is not a stable contract. Patterns are deliberately
 * narrow and ordered from the most to the least actionable class; anything unmatched is
 * "unknown", which keeps the generic recovery path.
 */
const LOG_PATTERNS: readonly [TunnelReason, RegExp][] = [
  [
    "profile_missing",
    /\bprofile\b[^\n]*\b(?:not found|does ?n[o']t exist|is missing|missing|no such|unknown|not configured)\b|\b(?:no|unknown|missing) profile\b|\bprofile_not_found\b/i,
  ],
  [
    "auth",
    /\b(?:unauthori[sz]ed|unauthenticated|forbidden|invalid[ _-]?(?:api[ _-]?)?key|invalid_api_key|authentication (?:failed|error|required)|auth(?:entication)? failed|status(?: code)?[ :=]*40[13])\b|\bapi[ _-]?key\b[^\n]*\b(?:invalid|missing|expired|revoked|required|not set|rejected)\b|\bCONTROL_PLANE_API_KEY\b[^\n]*\b(?:missing|not set|required|invalid|empty)\b/i,
  ],
  [
    "workbench",
    /\b(?:WORKBENCH_[A-Z_]+|RELAY_[A-Z_]+|COMPANION_UNAVAILABLE)\b|本機工作台(?:已離線|無法|尚未)|找不到有效的本機工作台/,
  ],
  [
    "network",
    /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENETDOWN|network (?:is )?(?:unreachable|error|down)|connection (?:refused|reset|timed out)|i\/o timeout|tls handshake (?:timeout|failed|error)|no such host|temporary failure in name resolution|could not resolve host|dial tcp)\b/i,
  ],
];

const PRIORITY: readonly TunnelReason[] = ["profile_missing", "auth", "workbench", "network"];

/** Text of a log line worth classifying: plain lines, or JSON entries at WARN level or above. */
function classifiableText(line: string): string | undefined {
  try {
    const entry = JSON.parse(line);
    if (typeof entry !== "object" || entry === null) return line;
    const level = String(entry.level ?? entry.severity ?? "").toUpperCase();
    return ["WARN", "WARNING", "ERROR", "FATAL", "CRITICAL"].includes(level) ? line : undefined;
  } catch {
    return line;
  }
}

/** Classifies one already redacted log line; undefined when it names no known failure class. */
export function classifyTunnelLine(line: string): TunnelReason | undefined {
  const text = classifiableText(line);
  if (!text) return undefined;
  return LOG_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** Keeps the most actionable class seen in this run. */
export function strongerReason(
  current: TunnelReason | undefined,
  next: TunnelReason | undefined,
): TunnelReason | undefined {
  if (!next) return current;
  if (!current) return next;
  return PRIORITY.indexOf(next) < PRIORITY.indexOf(current) ? next : current;
}

/**
 * Exit codes that mean the program itself could not be found: 127 from a POSIX shell and 9009
 * from cmd.exe. Everything else is decided by the log lines of the run.
 */
export function tunnelExitReason(
  exitCode: number | null | undefined,
  fromLogs: TunnelReason | undefined,
): TunnelReason {
  if (exitCode === 127 || exitCode === 9009) return "not_installed";
  return fromLogs ?? "unknown";
}

/** Spawn errors: a missing executable is not_installed; anything else stays unknown. */
export function tunnelSpawnReason(error: unknown): TunnelReason {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  return code === "ENOENT" || /\bENOENT\b|no such file or directory|not found/i.test(message)
    ? "not_installed"
    : "unknown";
}

export const TUNNEL_RESTART_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];
export const TUNNEL_RESTART_WINDOW_MS = 5 * 60_000;

/**
 * Bounded automatic restart: the n-th restart within the window waits delays[n]; once the
 * delays are used up no further restart is scheduled until an explicit start. Permanent
 * failures (auth, missing profile, missing client) are never retried.
 */
export function nextTunnelRestartDelay(
  reason: TunnelReason,
  recentRestarts: readonly number[],
  now: number,
  delays: readonly number[] = TUNNEL_RESTART_DELAYS_MS,
  windowMs = TUNNEL_RESTART_WINDOW_MS,
): number | undefined {
  if (PERMANENT_TUNNEL_REASONS.includes(reason)) return undefined;
  const inWindow = recentRestarts.filter((time) => now - time < windowMs).length;
  return delays[inWindow];
}
