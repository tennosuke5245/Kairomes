/** Registers `wake` for the next relevant change and returns a function that unregisters it. */
export type ChangeSubscription = (wake: () => void) => () => void;

/**
 * Waits for the next change reported through `subscribe`. Resolves true after waiting, or false
 * at once when no wait slot is free, so the caller simply answers like a plain poll.
 */
export type PollWait = (subscribe: ChangeSubscription) => Promise<boolean>;

/**
 * Bounded long-poll waiters for one tool service. Each wait ends on the first change, its
 * timeout or close(), whichever comes first; at most `limit` callers wait at the same time.
 */
export class PollWaiters {
  private readonly releases = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly limit: number,
    private readonly onWaiting: (waiting: boolean) => void = () => {},
  ) {}

  get waiting() {
    return this.releases.size;
  }

  wait(ms: number, subscribe: ChangeSubscription): Promise<boolean> {
    if (ms <= 0 || this.closed || this.releases.size >= this.limit) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      const release = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        this.releases.delete(release);
        this.onWaiting(false);
        resolve(true);
      };
      const timer = setTimeout(release, ms);
      this.releases.add(release);
      this.onWaiting(true);
      const stop = subscribe(release);
      // A change reported during subscribe() already released this waiter.
      if (settled) stop();
      else unsubscribe = stop;
    });
  }

  /** Releases every waiter and refuses new waits; their polls then answer with current state. */
  close() {
    this.closed = true;
    for (const release of [...this.releases]) release();
  }
}

/** Per-job change listeners used by a manager to wake its long polls. */
export class ChangeWatchers {
  private readonly watchers = new Map<string, Set<() => void>>();

  subscribe(id: string): ChangeSubscription {
    return (wake) => {
      let listeners = this.watchers.get(id);
      if (!listeners) {
        listeners = new Set();
        this.watchers.set(id, listeners);
      }
      listeners.add(wake);
      return () => {
        const current = this.watchers.get(id);
        current?.delete(wake);
        if (current?.size === 0) this.watchers.delete(id);
      };
    };
  }

  wake(id: string) {
    const listeners = this.watchers.get(id);
    if (!listeners) return;
    this.watchers.delete(id);
    for (const wake of listeners) wake();
  }

  wakeAll() {
    for (const id of [...this.watchers.keys()]) this.wake(id);
  }
}
