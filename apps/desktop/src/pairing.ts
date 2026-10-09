import type { PairingResult } from "./api.ts";

/**
 * The one-time pairing link on 連線設定. It is a credential: shown, never logged or persisted,
 * and gone when it expires, when a side panel uses it or when the page is left.
 */
export type PairingLink = {
  /** The one-time link; empty once cleared. Never logged or persisted. */
  url: string;
  receivedAt: number;
  expiresInSeconds?: number;
  /**
   * Paired panels the link is measured against: the count when it arrived, lowered to any
   * smaller count seen while it is live. Null until a count is known.
   */
  pairedAtStart: number | null;
  cleared?: "expired" | "left" | "used";
};

/**
 * Keeps a link the host returned only while 連線設定 is still open. The host can take a while
 * (saving an Extension ID restarts the workbench), and a link that arrives after the user left
 * is dropped at once instead of waiting off-screen for its whole lifetime.
 */
export function receivePairing(
  result: PairingResult,
  context: { onPage: boolean; pairedPanels: number | null; now: number },
): PairingLink | null {
  if (!result.pairingUrl || !context.onPage) return null;
  return {
    url: result.pairingUrl,
    receivedAt: context.now,
    expiresInSeconds: result.expiresInSeconds,
    pairedAtStart: context.pairedPanels,
  };
}

/** Leaving 連線設定 clears a live link; a cleared or absent one stays as it is. */
export function leavePairing(pairing: PairingLink | null): PairingLink | null {
  return pairing?.url ? { ...pairing, url: "", cleared: "left" } : pairing;
}

/**
 * Follows a live link against the time left and the paired-panel count; returns the same
 * object when nothing changed. The baseline first falls to any lower count, because saving an
 * Extension ID restarts the workbench, which forgets earlier pairings; only a count above the
 * baseline means a panel paired with this link.
 */
export function followPairing(
  pairing: PairingLink,
  remainingMs: number,
  pairedPanels: number | null,
): PairingLink {
  if (!pairing.url) return pairing;
  if (remainingMs <= 0) return { ...pairing, url: "", cleared: "expired" };
  if (pairedPanels === null) return pairing;
  if (pairing.pairedAtStart === null || pairedPanels < pairing.pairedAtStart)
    return { ...pairing, pairedAtStart: pairedPanels };
  if (pairedPanels > pairing.pairedAtStart) return { ...pairing, url: "", cleared: "used" };
  return pairing;
}
