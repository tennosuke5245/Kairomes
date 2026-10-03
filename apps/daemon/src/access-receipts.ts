import { createHash } from "node:crypto";
import {
  KairomesError,
  PANEL_ACCESS_LIMITS,
  type PanelAccessReceipt,
  panelAccessIdentity,
  publicError,
  type TrackedPanelAccessMutation,
} from "@kairomes/protocol";

interface Entry {
  fingerprint: string;
  workspaceId: string;
  validUntil: number;
  state: PanelAccessReceipt["state"];
  cancelled: boolean;
  recovery: boolean;
  inFlight: boolean;
  reserved: boolean;
  recoveryId?: string;
  finishedAt?: number;
  message?: string;
}
interface Owner {
  entries: Map<string, Entry>;
  primary: number;
  reserved: number;
}
type ReceiptLimits = { [K in keyof typeof PANEL_ACCESS_LIMITS]: number };

/** Private to one workbench instance and its currently valid panel tokens. */
export class AccessReceipts {
  private owners = new Map<string, Owner>();

  constructor(
    private readonly ownerValid: (owner: string) => boolean,
    private readonly now = Date.now,
    private readonly limits: ReceiptLimits = PANEL_ACCESS_LIMITS,
  ) {}

  private prune() {
    for (const [token, owner] of this.owners) {
      if (!this.ownerValid(token)) {
        for (const entry of owner.entries.values()) entry.cancelled = true;
        this.owners.delete(token);
        continue;
      }
      const finished = [...owner.entries.values()].filter(
        (entry) => entry.finishedAt !== undefined && !entry.inFlight,
      );
      finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
      for (const [index, entry] of finished.entries()) {
        if (
          this.now() - (entry.finishedAt ?? 0) >= this.limits.receiptMs ||
          index < finished.length - this.limits.receipts
        ) {
          entry.state = "expired";
          entry.message = undefined;
          entry.finishedAt = undefined;
        }
      }
    }
  }

  private owner(token: string) {
    this.prune();
    if (!this.ownerValid(token)) throw new KairomesError("ACCESS_INVALID", "配對已失效。");
    let owner = this.owners.get(token);
    if (!owner) {
      if (this.owners.size >= this.limits.owners)
        throw new KairomesError("ACCESS_RECEIPT_LIMIT", "結果待確認。");
      owner = { entries: new Map(), primary: 0, reserved: 0 };
      this.owners.set(token, owner);
    }
    return owner;
  }

  private receipt(id: string, entry?: Entry): PanelAccessReceipt {
    return {
      request_id: id,
      fingerprint: entry?.fingerprint ?? null,
      state: entry?.state ?? "missing",
      ...(entry?.message ? { message: entry.message } : {}),
    };
  }

  status(token: string, id: string) {
    this.prune();
    return this.receipt(id, this.owners.get(token)?.entries.get(id));
  }

  async run(
    token: string,
    input: TrackedPanelAccessMutation,
    execute: (valid: () => boolean) => Promise<void>,
  ): Promise<PanelAccessReceipt> {
    const owner = this.owner(token);
    const fingerprint = createHash("sha256").update(panelAccessIdentity(input)).digest("hex");
    const existing = owner.entries.get(input.request_id);
    if (existing) {
      if (
        existing.fingerprint !== fingerprint ||
        existing.workspaceId !== input.workspace_id ||
        existing.validUntil !== input.valid_until
      )
        throw new KairomesError("ACCESS_REQUEST_CHANGED", "請求已變更；請重新審閱。");
      return this.receipt(input.request_id, existing);
    }
    if (input.valid_until <= this.now() || input.valid_until > this.now() + this.limits.intentMs)
      throw new KairomesError("ACCESS_REQUEST_EXPIRED", "請求已到期。");
    const supersedes = input.action === "disable" ? input.supersedes : undefined;
    const prior = supersedes ? owner.entries.get(supersedes.request_id) : undefined;
    if (
      supersedes &&
      (supersedes.valid_until > this.now() + this.limits.intentMs ||
        (prior &&
          (prior.fingerprint !== supersedes.fingerprint ||
            prior.workspaceId !== input.workspace_id ||
            prior.validUntil !== supersedes.valid_until ||
            prior.recoveryId !== undefined)))
    )
      throw new KairomesError("ACCESS_REQUEST_CHANGED", "請求已變更；請重新審閱。");
    const recovery = supersedes !== undefined;
    const pending = [...owner.entries.values()].filter(
      (entry) => entry.inFlight && entry.recovery === recovery,
    ).length;
    const consumedReservation = prior?.reserved ? 1 : 0;
    const additionalIds = supersedes && !prior ? 2 : 1;
    const nextReserved = owner.reserved - consumedReservation + (recovery ? 0 : 1);
    if (
      pending >= this.limits.pending ||
      owner.entries.size + additionalIds + nextReserved > this.limits.ids ||
      (!recovery && owner.primary >= this.limits.primaryIds)
    )
      throw new KairomesError("ACCESS_RECEIPT_LIMIT", "結果待確認。");

    // Reserve and fence synchronously before granting, revoking or awaiting cleanup.
    const entry: Entry = {
      fingerprint,
      workspaceId: input.workspace_id,
      validUntil: input.valid_until,
      state: "pending",
      cancelled: false,
      recovery,
      inFlight: true,
      reserved: !recovery,
    };
    if (supersedes) {
      const fenced = prior ?? {
        fingerprint: supersedes.fingerprint,
        workspaceId: input.workspace_id,
        validUntil: supersedes.valid_until,
        state: "superseded" as const,
        cancelled: true,
        recovery: true,
        inFlight: false,
        reserved: false,
      };
      fenced.reserved = false;
      fenced.cancelled = true;
      fenced.state = "superseded";
      fenced.finishedAt = this.now();
      fenced.recoveryId = input.request_id;
      owner.entries.set(supersedes.request_id, fenced);
    }
    owner.entries.set(input.request_id, entry);
    owner.reserved = nextReserved;
    if (!recovery) owner.primary++;
    const valid = () => this.ownerValid(token) && !entry.cancelled;
    try {
      await execute(valid);
      if (!entry.cancelled) entry.state = "completed";
    } catch (cause) {
      if (!entry.cancelled) {
        entry.state = "failed";
        entry.message = publicError(cause).message.slice(0, 200);
      }
    }
    entry.inFlight = false;
    entry.finishedAt = this.now();
    this.prune();
    return this.receipt(input.request_id, entry);
  }

  revoke(token: string) {
    for (const entry of this.owners.get(token)?.entries.values() ?? []) entry.cancelled = true;
    this.owners.delete(token);
  }

  close() {
    for (const token of this.owners.keys()) this.revoke(token);
  }
}
