// The upload identity rule for POST /api/panel/imports/:id/file. One upload ID per attempt;
// after an unconfirmed result the same bytes for the same import always reuse that ID, so a
// retry can only replay the first outcome on the daemon and never becomes a second upload.
// Like ApprovalMutationTracker, everything is scoped to one paired instance (`source`).

/** Import states that can still receive or hold an upload. */
const activeStates = new Set(["awaiting_file", "preparing", "pending", "applying"]);

export type UploadStatus = "sending" | "unknown" | "accepted" | "rejected";

export interface UploadAttempt {
  importId: string;
  uploadId: string;
  sha256: string;
  status: UploadStatus;
  /** Daemon error code of a refused upload. */
  code?: string;
}

export type UploadOutcome = "accepted" | "unknown" | { rejected: string };

/** The snapshot fields that settle an unconfirmed upload. */
export interface UploadObservation {
  id: string;
  state: string;
  upload_id: string | null;
  error_code: string | null;
}

export class ImageUploadTracker {
  private source: string | undefined;
  private attempts = new Map<string, UploadAttempt>();
  /** `${importId}:${sha256}` → the upload ID whose result is still unknown. */
  private unknownIds = new Map<string, string>();
  /** The attempt each in-flight send replaced, restored when that send never left the panel. */
  private replaced = new Map<string, UploadAttempt | undefined>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** A different paired instance starts empty; nothing from another one can be replayed. */
  bind(source: string | undefined) {
    if (source !== this.source) {
      this.attempts.clear();
      this.unknownIds.clear();
      this.replaced.clear();
    }
    this.source = source;
  }

  /**
   * The upload ID for these bytes, or undefined while another attempt for the same import is
   * still being sent. Bytes whose earlier attempt is unconfirmed get that attempt's ID back.
   */
  begin(source: string | undefined, importId: string, sha256: string) {
    if (source === undefined || source !== this.source) return undefined;
    if (this.attempts.get(importId)?.status === "sending") return undefined;
    const uploadId = this.unknownIds.get(`${importId}:${sha256}`) ?? this.newId();
    this.replaced.set(importId, this.attempts.get(importId));
    this.attempts.set(importId, { importId, uploadId, sha256, status: "sending" });
    return uploadId;
  }

  /**
   * The send was refused before any request left the panel (offline, no pairing): nothing
   * happened, so the earlier attempt and its unconfirmed upload ID stay exactly as they were.
   */
  unsent(source: string | undefined, importId: string, uploadId: string) {
    if (source !== this.source) return;
    const attempt = this.attempts.get(importId);
    if (attempt?.uploadId !== uploadId || attempt.status !== "sending") return;
    const previous = this.replaced.get(importId);
    this.replaced.delete(importId);
    if (previous) this.attempts.set(importId, previous);
    else this.attempts.delete(importId);
  }

  settle(source: string | undefined, importId: string, uploadId: string, outcome: UploadOutcome) {
    if (source !== this.source) return;
    const attempt = this.attempts.get(importId);
    if (!attempt || attempt.uploadId !== uploadId) return;
    this.replaced.delete(importId);
    const key = `${importId}:${attempt.sha256}`;
    if (outcome === "unknown") {
      attempt.status = "unknown";
      this.unknownIds.set(key, uploadId);
      return;
    }
    this.unknownIds.delete(key);
    if (outcome === "accepted") attempt.status = "accepted";
    else {
      attempt.status = "rejected";
      attempt.code = outcome.rejected;
    }
  }

  /**
   * Settles unconfirmed attempts from the authoritative snapshot. Only the import's own
   * `upload_id` counts: the same ID in `pending` (or later) means accepted; back in
   * `awaiting_file` with an error means refused. Another ID or none proves nothing, so the
   * attempt stays unknown until the import itself ends.
   */
  observe(source: string | undefined, items: readonly UploadObservation[]) {
    if (source !== this.source) return;
    for (const [importId, attempt] of this.attempts) {
      if (attempt.status !== "unknown") continue;
      const item = items.find((entry) => entry.id === importId);
      const key = `${importId}:${attempt.sha256}`;
      const ours = item?.upload_id === attempt.uploadId;
      if (!item || (!ours && !activeStates.has(item.state))) {
        // The import ended without these bytes; nothing is left to retry or reconcile.
        this.attempts.delete(importId);
        this.unknownIds.delete(key);
        continue;
      }
      if (!ours || item.state === "preparing") continue;
      this.unknownIds.delete(key);
      if (item.state === "awaiting_file") {
        attempt.status = "rejected";
        attempt.code = item.error_code ?? "UPLOAD_REJECTED";
      } else attempt.status = "accepted";
    }
  }

  /** The latest attempt for an import in this instance, for the drop zone's status line. */
  status(source: string | undefined, importId: string) {
    return source !== undefined && source === this.source ? this.attempts.get(importId) : undefined;
  }

  get hasUnknown() {
    return [...this.attempts.values()].some((attempt) => attempt.status === "unknown");
  }
}
