import type { AccessGrant } from "@kairomes/protocol";
import type { PanelIcon } from "./icons.ts";

/** A timed grant shows its urgency style for its last two minutes (spec §4 countdown). */
export const GRANT_SOON_MS = 2 * 60_000;

/** Milliseconds left on a timed grant, never negative; null for a 直到收回 grant. */
export function grantRemaining(grant: Pick<AccessGrant, "expires_at">, now = Date.now()) {
  return grant.expires_at === null ? null : Math.max(0, grant.expires_at - now);
}

/** `m:ss` below an hour, `h:mm:ss` above. Rounds up, so 0:00 only shows once expired. */
export function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The local clock time a grant ends, rounded up to the minute so it never reads as over
 * early: `14:31`. Grants last at most 4 hours, so the next such clock time is the one meant;
 * anything 12 hours or more away also names the day (`10月8日 09:05`).
 */
export function expiryClock(expiresAt: number, now = Date.now()) {
  const end = new Date(Math.ceil(expiresAt / 60_000) * 60_000);
  const clock = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return expiresAt - now < 12 * 3_600_000
    ? clock
    : `${end.getMonth() + 1}月${end.getDate()}日 ${clock}`;
}

/** A timed grant's toolbar time, split so the tightest toolbar can drop the `剩 ` lead. */
export interface GrantTime {
  lead: string;
  value: string;
  tail: string;
}

/**
 * Under an hour a countdown (`剩 12:05`); from an hour up the expiry clock (`14:31 到期`),
 * which stays short where `剩 1:00:00` would push the toolbar's controls out of view.
 */
export function grantTime(expiresAt: number, now = Date.now()): GrantTime {
  const remaining = Math.max(0, expiresAt - now);
  if (Math.ceil(remaining / 1000) < 3600)
    return { lead: "剩 ", value: formatRemaining(remaining), tail: "" };
  return { lead: "", value: expiryClock(expiresAt, now), tail: " 到期" };
}

export const grantTimeText = (time: GrantTime) => `${time.lead}${time.value}${time.tail}`;

/** The same remaining time for an accessible name, e.g. `12 分 5 秒`. */
export function spokenRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return minutes ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  if (minutes) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  return `${seconds} 秒`;
}

export type GrantPhase = "steady" | "soon" | "expired";

export function grantPhase(remaining: number | null): GrantPhase {
  if (remaining === null) return "steady";
  if (remaining <= 0) return "expired";
  return remaining <= GRANT_SOON_MS ? "soon" : "steady";
}

/** Grants still in force at `now`; an expired grant never counts as autonomy. */
export function activeGrants<T extends Pick<AccessGrant, "expires_at">>(
  grants: readonly T[] | undefined,
  now = Date.now(),
) {
  return (grants ?? []).filter((grant) => grant.expires_at === null || grant.expires_at > now);
}

export const levelLabel = (level: AccessGrant["level"]) =>
  level === "full" ? "全自主" : "檔案自主";

export interface AccessChip {
  /** `data-mode` on `.k-access`: auto and files get the warning tint. */
  mode: "step" | "files" | "auto" | "unknown";
  icon: PanelIcon;
  /** Filled lightning while 全自主 is in force (spec §6). */
  fill: boolean;
  /** Collapses to an icon below 380px, or below 440px beside a time or running work. */
  label: string;
  /** `剩 m:ss` or `14:31 到期` for the earliest timed grant; it always stays visible. */
  time?: GrantTime;
  urgent: boolean;
  ariaLabel: string;
}

/**
 * The toolbar access chip. Browsing one project shows that project's mode; browsing all
 * projects summarises every grant. A timed grant always shows `剩 m:ss` from its own
 * `expires_at`; nothing here extends a grant.
 */
export function accessChip(input: {
  grants: readonly AccessGrant[] | undefined;
  workspaceId: string | null;
  available: boolean;
  unknown: boolean;
  now?: number;
}): AccessChip {
  if (!input.available || input.unknown)
    return {
      mode: "unknown",
      icon: "Question",
      fill: false,
      label: "權限待確認",
      urgent: false,
      ariaLabel: "操作模式：權限待確認",
    };
  const now = input.now ?? Date.now();
  const grants = activeGrants(input.grants, now).filter(
    (grant) => input.workspaceId === null || grant.workspace_id === input.workspaceId,
  );
  if (!grants.length)
    return {
      mode: "step",
      icon: "ShieldCheck",
      fill: false,
      label: "逐步確認",
      urgent: false,
      ariaLabel: "操作模式：逐步確認",
    };
  const full = grants.some((grant) => grant.level === "full");
  const timed = grants
    .map((grant) => grant.expires_at)
    .filter((expiresAt): expiresAt is number => expiresAt !== null);
  const earliest = timed.length ? Math.min(...timed) : null;
  const label =
    input.workspaceId === null
      ? `${grants.length} 個專案自主`
      : levelLabel(grants[0]?.level ?? "full");
  const spoken = grants
    .map((grant) => {
      const remaining = grantRemaining(grant, now);
      return `${input.workspaceId === null ? `${grant.workspace_name} ` : ""}${levelLabel(grant.level)}，${
        remaining === null ? "直到收回" : `剩 ${spokenRemaining(remaining)}`
      }`;
    })
    .join("；");
  return {
    mode: full ? "auto" : "files",
    icon: full ? "Lightning" : "PencilSimple",
    fill: full,
    label,
    ...(earliest === null ? {} : { time: grantTime(earliest, now) }),
    urgent: grantPhase(earliest === null ? null : Math.max(0, earliest - now)) === "soon",
    ariaLabel: `操作模式：${spoken}`,
  };
}

/**
 * Live-region messages when a timed grant enters its last two minutes or runs out. The
 * countdown itself is never announced every second (spec §8).
 */
export function grantAnnouncements(
  previous: ReadonlyMap<string, GrantPhase>,
  grants: readonly AccessGrant[] | undefined,
  now = Date.now(),
) {
  const next = new Map<string, GrantPhase>();
  const messages: string[] = [];
  for (const grant of grants ?? []) {
    const phase = grantPhase(grantRemaining(grant, now));
    next.set(grant.id, phase);
    const before = previous.get(grant.id);
    if (before === undefined || before === phase) continue;
    const name = `${grant.workspace_name} ${levelLabel(grant.level)}`;
    if (phase === "soon") messages.push(`${name}剩不到 2 分鐘`);
    if (phase === "expired") messages.push(`${name}已到期，改回逐步確認`);
  }
  return { phases: next, messages };
}
