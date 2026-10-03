import { type HandoffInput, KairomesError } from "@kairomes/protocol";
import type { HandoffBriefs } from "../../daemon/src/handoff-brief.ts";

type Start = Extract<HandoffInput, { action: "start" }>;
type Ticket = { controller: AbortController; expiresAt: number };

/** Reserves a start before Companion initialization can yield to an early cancel. */
export class HandoffStarts {
  private tickets = new Map<string, Ticket>();
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  private prune() {
    for (const ticket of this.tickets.values()) {
      if (ticket.expiresAt > this.now()) continue;
      ticket.controller.abort();
    }
  }

  cancel(id: string) {
    this.tickets.get(id)?.controller.abort();
    // Keep the identity reserved until this operation settles, including expiry. An old
    // initializer must not start or cancel a replacement with the same UUID.
  }

  cancelAll() {
    for (const ticket of this.tickets.values()) ticket.controller.abort();
  }

  close() {
    this.closed = true;
    this.cancelAll();
  }

  async run(
    input: Start,
    signal: AbortSignal,
    prepare: (check: () => void) => Promise<Pick<HandoffBriefs, "perform">>,
  ) {
    this.prune();
    if (this.closed) throw new KairomesError("HANDOFF_EXPIRED", "接續服務已停止。");
    const id = input.draft_id ?? crypto.randomUUID();
    if (this.tickets.has(id)) throw new KairomesError("HANDOFF_DUPLICATE", "此接續草稿已存在。");
    if (this.tickets.size >= 4) throw new KairomesError("HANDOFF_LIMIT", "請先關閉其他接續草稿。");
    const ticket = { controller: new AbortController(), expiresAt: this.now() + 10 * 60 * 1000 };
    this.tickets.set(id, ticket);
    const cancel = () => ticket.controller.abort();
    const check = () => {
      this.prune();
      if (this.closed || this.tickets.get(id) !== ticket || ticket.controller.signal.aborted)
        throw new KairomesError("HANDOFF_CANCELLED", "已取消來源讀取。");
    };
    signal.addEventListener("abort", cancel, { once: true });
    let briefs: Pick<HandoffBriefs, "perform"> | undefined;
    let created = false;
    try {
      if (signal.aborted) cancel();
      check();
      briefs = await prepare(check);
      check();
      const result = await briefs.perform({ ...input, draft_id: id }, ticket.controller.signal);
      created = true;
      check();
      return result;
    } catch (error) {
      // The request can abort after perform has returned and removed its own abort
      // listener, but before the start reply is delivered. Cleanup that successful
      // reservation as well; failures such as DUPLICATE never own an existing draft.
      if (created && briefs && this.tickets.get(id) === ticket)
        await briefs.perform({ action: "cancel", draft_id: id }).catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.tickets.get(id) === ticket) this.tickets.delete(id);
    }
  }
}
