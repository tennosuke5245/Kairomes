import { PERMANENT_TUNNEL_REASONS, type TunnelReason } from "@kairomes/protocol";

/**
 * Tunnel failure classification. Only the enum leaves this module; matched log text stays in
 * the Companion's existing redacted log tail.
 *
 * The official tunnel-client's exact wording is not a stable contract. Patterns are deliberately
 * narrow and ordered from the most to the least actionable class; anything unmatched is
 * "unknown", which keeps the generic recovery path. The profile and API key patterns allow only
 * a quoted name or a few words between the subject and the failure, so a structured logger's
 * `profile=kairomes` attribute next to an unrelated message never matches.
 */
const LOG_PATTERNS: readonly [TunnelReason, RegExp][] = [
  [
    "profile_missing",
    /\bprofile\b(?:\s*[:=]\s*|\s+)?(?:["'`][^"'`\n]{0,64}["'`]|[\w.-]{1,64})?\s*(?:(?:was|is|does)\s+)?(?:not found|not exist|does ?n[o']t exist|is missing|missing|not configured)\b|\b(?:no such|no|unknown|missing|invalid)\s+profile\b|\b(?:could ?n[o']t|cannot|can't|unable to|failed to)\s+(?:find|load|read)\s+profile\b|\bprofile_not_found\b/i,
  ],
  [
    "auth",
    /\b(?:unauthori[sz]ed|unauthenticated|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|authentication (?:failed|error|required)|auth(?:entication)? failed|status(?: code)?[ :=]*40[13])\b|\bapi[ _-]?key\b(?:\s+\S+){0,3}?\s+(?:invalid|missing|expired|revoked|required|not set|rejected)\b|\bCONTROL_PLANE_API_KEY\b(?:\s+\S+){0,3}?\s+(?:missing|not set|required|invalid|empty)\b/i,
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
const SEVERE_LEVELS = ["WARN", "WARNING", "ERROR", "FATAL", "CRITICAL", "PANIC"];
/** Fields of a structured entry that hold its message; attribute keys and values never count. */
const MESSAGE_FIELDS = ["msg", "message", "error", "err"];

function severe(level: unknown) {
  return SEVERE_LEVELS.includes(String(level ?? "").toUpperCase());
}

function messageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string")
    return value.message;
  return undefined;
}

/** `key=value` or `key="quoted value"` pairs of a logfmt line, for the message fields only. */
function logfmtMessages(line: string) {
  const parts: string[] = [];
  for (const match of line.matchAll(/(?:^|\s)(msg|message|err|error)=("(?:[^"\\]|\\.)*"|\S+)/gi)) {
    const value = match[2] ?? "";
    parts.push(value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value);
  }
  return parts.join(" ");
}

/**
 * Text of a log line worth classifying. JSON and logfmt entries count only at WARN level or
 * above, and only their message and error fields; any other line is classified as a whole.
 */
function classifiableText(line: string): string | undefined {
  try {
    const entry: unknown = JSON.parse(line);
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (!severe(record.level ?? record.severity)) return undefined;
      return MESSAGE_FIELDS.map((key) => messageText(record[key]))
        .filter((text): text is string => Boolean(text))
        .join(" ");
    }
  } catch {
    // Not JSON.
  }
  const logfmtLevel = /(?:^|\s)(?:level|lvl|severity)=("?)([A-Za-z]+)\1(?=\s|$)/.exec(line);
  if (logfmtLevel) return severe(logfmtLevel[2]) ? logfmtMessages(line) : undefined;
  return line;
}

/** Classifies one already redacted log line; undefined when it names no known failure class. */
export function classifyTunnelLine(line: string): TunnelReason | undefined {
  const text = classifiableText(line);
  if (!text) return undefined;
  return LOG_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

/** Keeps the more actionable of two classes. */
export function strongerReason(
  current: TunnelReason | undefined,
  next: TunnelReason | undefined,
): TunnelReason | undefined {
  if (!next) return current;
  if (!current) return next;
  return PRIORITY.indexOf(next) < PRIORITY.indexOf(current) ? next : current;
}

/** A run that ends sooner than this after launch failed at startup: all of its lines count. */
export const TUNNEL_STARTUP_MS = 10_000;
/** A longer run is judged by its last lines: those this close to the exit, ... */
export const TUNNEL_TAIL_MS = 3_000;
/** ... or among this many final process lines. */
export const TUNNEL_TAIL_LINES = 8;
const MAX_CLASSIFIED_LINES = 64;

/**
 * Failure evidence of one tunnel-client run. A long-running Tunnel logs per-request warnings
 * that say nothing about why it eventually exits, so only a startup failure or the lines right
 * before the exit decide the class; an old warning cannot make a later network drop look
 * permanent and switch off the automatic restart.
 */
export class TunnelRunLog {
  private lines = 0;
  private classified: { at: number; line: number; reason: TunnelReason }[] = [];

  constructor(private readonly startedAt: number) {}

  /** Records one redacted process line received at `at` (milliseconds). */
  add(line: string, at: number) {
    this.lines++;
    const reason = classifyTunnelLine(line);
    if (!reason) return;
    this.classified.push({ at, line: this.lines, reason });
    if (this.classified.length > MAX_CLASSIFIED_LINES) this.classified.shift();
  }

  /** The most actionable class among the lines that may explain an exit at `exitedAt`. */
  reason(exitedAt: number): TunnelReason | undefined {
    const startup = exitedAt - this.startedAt < TUNNEL_STARTUP_MS;
    let reason: TunnelReason | undefined;
    for (const entry of this.classified)
      if (
        startup ||
        exitedAt - entry.at <= TUNNEL_TAIL_MS ||
        this.lines - entry.line < TUNNEL_TAIL_LINES
      )
        reason = strongerReason(reason, entry.reason);
    return reason;
  }
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
  return code === "ENOENT" ||
    /\bENOENT\b|no such file or directory|\b(?:executable|command|program) not found\b|not found in \$?PATH\b/i.test(
      message,
    )
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
