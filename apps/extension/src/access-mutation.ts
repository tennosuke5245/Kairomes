import {
  type PanelAccessMutation,
  PanelAccessMutationSchema,
  PanelAccessReceiptSchema,
  type PanelConnection,
  panelAccessFingerprint,
  type TrackedPanelAccessMutation,
  z,
} from "@kairomes/protocol";

const SavedRequest = z
  .object({ request: PanelAccessMutationSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const SavedPending = SavedRequest.extend({ previous: SavedRequest.optional() }).strict();
interface Pending {
  request: TrackedPanelAccessMutation;
  fingerprint: string;
  unknown: boolean;
  previous?: Omit<Pending, "unknown" | "previous">;
}

/** One unfinished intent, owned by the trusted panel connection rather than its browsing filter. */
export class AccessMutationTracker {
  private source?: PanelConnection;
  private pending?: Pending;

  bind(source?: PanelConnection) {
    if (this.source === source) return;
    this.source = source;
    this.pending = undefined;
  }

  get current() {
    return this.pending;
  }

  get hasUnknown() {
    return this.pending?.unknown === true;
  }

  get unknownRequest() {
    return this.hasUnknown ? this.pending?.request : undefined;
  }

  begin(source: PanelConnection, request: TrackedPanelAccessMutation, fingerprint: string) {
    if (this.source !== source) return false;
    if (
      this.pending &&
      (!this.pending.unknown ||
        request.action !== "disable" ||
        this.pending.request.action !== "enable" ||
        request.workspace_id !== this.pending.request.workspace_id)
    )
      throw new Error("結果待確認。");
    const previous = this.pending
      ? { request: this.pending.request, fingerprint: this.pending.fingerprint }
      : undefined;
    this.pending = { request, fingerprint, unknown: false, ...(previous ? { previous } : {}) };
    return true;
  }

  markUnknown(source: PanelConnection, id: string) {
    if (this.source === source && this.pending?.request.request_id === id)
      this.pending.unknown = true;
  }

  reject(source: PanelConnection, id: string) {
    if (this.source !== source || this.pending?.request.request_id !== id) return;
    this.pending = this.pending.previous ? { ...this.pending.previous, unknown: true } : undefined;
  }

  observe(source: PanelConnection, receipt: unknown) {
    if (this.source !== source || !this.pending) return false;
    const parsed = PanelAccessReceiptSchema.safeParse(receipt);
    if (
      !parsed.success ||
      parsed.data.request_id !== this.pending.request.request_id ||
      parsed.data.fingerprint !== this.pending.fingerprint
    )
      return false;
    if (parsed.data.state !== "completed" && parsed.data.state !== "failed") {
      this.pending.unknown = true;
      return false;
    }
    this.pending = undefined;
    return true;
  }

  saved() {
    if (!this.pending) return undefined;
    return {
      request: this.pending.request,
      fingerprint: this.pending.fingerprint,
      ...(this.pending.previous ? { previous: this.pending.previous } : {}),
    };
  }

  async restore(source: PanelConnection, value: unknown) {
    const parsed = SavedPending.parse(value);
    const tracked = async (saved: { request: PanelAccessMutation; fingerprint: string }) => {
      if (!saved.request.request_id || !saved.request.valid_until) throw new Error("結果待確認。");
      const request = {
        ...saved.request,
        request_id: saved.request.request_id,
        valid_until: saved.request.valid_until,
      };
      if ((await panelAccessFingerprint(request)) !== saved.fingerprint)
        throw new Error("結果待確認。");
      return { request, fingerprint: saved.fingerprint };
    };
    const current = await tracked(parsed);
    const previous = parsed.previous ? await tracked(parsed.previous) : undefined;
    if (
      previous &&
      (current.request.action !== "disable" ||
        current.request.workspace_id !== previous.request.workspace_id ||
        current.request.supersedes?.request_id !== previous.request.request_id ||
        current.request.supersedes.fingerprint !== previous.fingerprint ||
        current.request.supersedes.valid_until !== previous.request.valid_until)
    )
      throw new Error("結果待確認。");
    if (current.request.action === "disable" && current.request.supersedes && !previous)
      throw new Error("結果待確認。");
    if (this.source !== source) return;
    this.pending = { ...current, unknown: true, ...(previous ? { previous } : {}) };
  }
}

export class AccessPendingConflict extends Error {
  constructor(readonly saved: unknown) {
    super("結果待確認。");
  }
}

interface PendingStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
type PendingLock = (key: string, work: () => Promise<void>) => Promise<void>;

/** Compare and update one owner's unfinished intent across trusted sidepanel documents. */
export async function writeAccessPending(
  storage: PendingStorage,
  source: PanelConnection,
  saved: ReturnType<AccessMutationTracker["saved"]>,
  expected?: { id: string; fingerprint: string },
  lock: PendingLock = (key, work) => navigator.locks.request(key, work),
) {
  const key = await accessPendingStorageKey(source);
  await lock(key, async () => {
    const existing = (await storage.get(key))[key];
    if (existing !== undefined) {
      const parsed = SavedPending.safeParse(existing);
      if (!parsed.success) throw new AccessPendingConflict(existing);
      const identity = parsed.data;
      const same =
        !!saved &&
        saved.request.request_id === identity.request.request_id &&
        saved.fingerprint === identity.fingerprint;
      const replacing =
        !!expected &&
        expected.id === identity.request.request_id &&
        expected.fingerprint === identity.fingerprint;
      if (!same && !replacing) throw new AccessPendingConflict(existing);
    }
    if (saved) await storage.set({ [key]: saved });
    else await storage.remove(key);
  });
}

/** The key binds session metadata to the exact instance, origin and panel owner without repeating its token. */
export async function accessPendingStorageKey(source: PanelConnection) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${source.origin}:${source.instanceId}:${source.panelToken}`),
  );
  const owner = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `kairomesPanelAccess:${owner}`;
}
