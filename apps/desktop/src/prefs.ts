/**
 * Per-viewer flags in localStorage: conveniences that are safe to lose. Storage can be missing
 * or throw (blocked site data, a private window), so every read and write is guarded and a
 * failure simply means the flag reads as unset.
 */

type FlagStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): FlagStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readFlag(key: string, store: FlagStorage | null = storage()): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string, store: FlagStorage | null = storage()): void {
  try {
    store?.setItem(key, "1");
  } catch {
    // Unavailable storage: the flag is asked for again next launch.
  }
}

/** The user said the Tunnel profile exists. */
export const PROFILE_ACK_KEY = "kairomes.desktop.profileAcknowledged";
