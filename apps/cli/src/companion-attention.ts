import { type CompanionPendingSummary, parseVersion } from "@kairomes/protocol";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_LISTS = ["sessions", "commands", "changes", "imports"] as const;
const MAX_ITEMS = 4096;

/**
 * Reduces the admin approvals list to counts. Fingerprints, argv, cwd, diffs and names are
 * discarded here and never reach the Companion status. Returns null for a malformed list.
 */
export function pendingSummary(body: unknown, now = Date.now()): CompanionPendingSummary | null {
  if (!body || typeof body !== "object") return null;
  const counts = new Map<string, number>();
  let total = 0;
  for (const key of APPROVAL_LISTS) {
    const items: unknown = (body as Record<string, unknown>)[key];
    // An older workbench may not list media imports yet; every other list is required.
    if (items === undefined && key === "imports") continue;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return null;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const { state, workspace_id, expires_at } = item as Record<string, unknown>;
      if (state !== "pending" || typeof workspace_id !== "string" || !UUID.test(workspace_id))
        continue;
      if (typeof expires_at === "number" && expires_at <= now) continue;
      counts.set(workspace_id, (counts.get(workspace_id) ?? 0) + 1);
      total++;
    }
  }
  return {
    total,
    byWorkspace: [...counts]
      .map(([workspace_id, count]) => ({ workspace_id, count }))
      .sort((a, b) => b.count - a.count || a.workspace_id.localeCompare(b.workspace_id)),
  };
}

/** The /api/connection fields the Companion keeps; anything else is ignored. */
export function connectionSummary(body: unknown): {
  lastMcpRequestAt: string | null;
  pairedPanels: number | null;
} {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const last = value.lastMcpRequestAt;
  const panels = value.pairedPanels;
  return {
    lastMcpRequestAt:
      typeof last === "string" && last.length <= 40 && Number.isFinite(Date.parse(last))
        ? new Date(last).toISOString()
        : null,
    pairedPanels:
      typeof panels === "number" && Number.isSafeInteger(panels) && panels >= 0 && panels <= 1000
        ? panels
        : null,
  };
}

/** Version of a Companion or workbench /healthz body; null when absent or not plain semver. */
export function healthVersion(body: unknown) {
  return body && typeof body === "object"
    ? parseVersion((body as Record<string, unknown>).version)
    : null;
}
