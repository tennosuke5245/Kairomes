import type { ApprovalItem } from "./approval-state.ts";

type Identity = Pick<ApprovalItem, "id" | "fingerprint" | "state" | "expires_at"> & {
  request_id?: string;
};

function identity(item: Identity) {
  return JSON.stringify([item.id, item.request_id ?? item.id, item.fingerprint]);
}

/** A fresh copy of the same pending request is not evidence that a decision never ran. */
export class ApprovalMutationTracker {
  private source: string | undefined;
  private unknown = new Map<string, Identity>();

  bind(source: string | undefined) {
    if (this.source !== source) this.unknown.clear();
    this.source = source;
  }

  markUnknown(source: string, item: Identity) {
    if (source !== this.source) return;
    this.unknown.set(identity(item), {
      id: item.id,
      request_id: item.request_id,
      fingerprint: item.fingerprint,
      state: item.state,
      expires_at: item.expires_at,
    });
  }

  get hasUnknown() {
    return this.unknown.size > 0;
  }

  isLocked(source: string | undefined, item: Identity) {
    return source === this.source && this.unknown.has(identity(item));
  }

  observe(source: string, items: readonly Identity[], now = Date.now()) {
    if (source !== this.source) return;
    for (const [key, original] of this.unknown) {
      const current = items.find((item) => item.id === original.id);
      if (
        !current ||
        identity(current) !== key ||
        current.state !== original.state ||
        (current.state === "pending" && current.expires_at <= now)
      )
        this.unknown.delete(key);
    }
  }
}
