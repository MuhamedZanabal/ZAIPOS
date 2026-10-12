import type { OrderEvent } from "./types";

/** Every downstream system implements this. Must be idempotent on event.key. */
export interface OrderSyncAdapter {
  readonly name: string;
  onEvent(event: OrderEvent): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** Thrown when retrying cannot help (bad config, validation). Goes straight to dead-letter. */
export class PermanentSyncError extends Error {}

export interface Delivery {
  eventId: string; adapter: string; attempts: number; nextAttemptAt: number;
  state: "pending" | "done" | "dead"; lastError: string | null;
}

export interface OutboxRepo {
  pendingEvents(now: number, limit: number): Promise<{ event: OrderEvent; delivery: Delivery }[]>;
  saveDelivery(d: Delivery): Promise<void>;
}

export const backoffMs = (attempt: number, baseMs = 2000, capMs = 15 * 60_000, rand = Math.random) =>
  Math.min(capMs, baseMs * 2 ** (attempt - 1)) * (0.8 + 0.4 * rand());

export class OutboxDispatcher {
  constructor(private repo: OutboxRepo, private adapters: OrderSyncAdapter[], private opts: { maxAttempts?: number; baseMs?: number; now?: () => number; log?: (e: string, d: object) => void } = {}) {}

  /** pendingEvents returns all pending rows (due or not) in per-order version order. One pass: deliver every due (event, adapter) pair. Events per order are delivered in version order. */
  async runOnce(limit = 50): Promise<{ done: number; retried: number; dead: number }> {
    const now = this.opts.now?.() ?? Date.now();
    const stats = { done: 0, retried: 0, dead: 0 };
    const rows = await this.repo.pendingEvents(now, limit);
    const blockedOrders = new Set<string>(); // keep per-order, per-adapter ordering
    for (const { event, delivery } of rows) {
      const lane = `${event.orderId}|${delivery.adapter}`;
      if (blockedOrders.has(lane)) continue;
      // An earlier event for this order is still backing off: later events wait behind it.
      if (delivery.nextAttemptAt > now) { blockedOrders.add(lane); continue; }
      const adapter = this.adapters.find((a) => a.name === delivery.adapter);
      if (!adapter) continue;
      try {
        await adapter.onEvent(event);
        await this.repo.saveDelivery({ ...delivery, attempts: delivery.attempts + 1, state: "done", lastError: null });
        stats.done++;
      } catch (e) {
        const attempts = delivery.attempts + 1;
        const permanent = e instanceof PermanentSyncError;
        const dead = permanent || attempts >= (this.opts.maxAttempts ?? 8);
        await this.repo.saveDelivery({ ...delivery, attempts, state: dead ? "dead" : "pending", lastError: String((e as Error)?.message ?? e),
          nextAttemptAt: now + backoffMs(attempts, this.opts.baseMs) });
        this.opts.log?.(dead ? "outbox_dead_letter" : "outbox_retry", { adapter: delivery.adapter, event: event.key, error: String(e) });
        if (dead) stats.dead++; else stats.retried++;
        blockedOrders.add(lane);
      }
    }
    return stats;
  }
}

/** In-memory repo: one delivery row per (event, adapter), created on first sight. */
export class MemoryOutboxRepo implements OutboxRepo {
  deliveries = new Map<string, Delivery>();
  constructor(private events: () => OrderEvent[], private adapterNames: string[]) {}
  async pendingEvents(now: number, limit: number) {
    const out: { event: OrderEvent; delivery: Delivery }[] = [];
    for (const event of [...this.events()].sort((a, b) => a.at.localeCompare(b.at) || a.version - b.version)) {
      for (const adapter of this.adapterNames) {
        const k = `${event.id}|${adapter}`;
        let d = this.deliveries.get(k);
        if (!d) { d = { eventId: event.id, adapter, attempts: 0, nextAttemptAt: 0, state: "pending", lastError: null }; this.deliveries.set(k, d); }
        if (d.state === "pending") out.push({ event, delivery: { ...d } });
      }
    }
    return out.slice(0, limit);
  }
  async saveDelivery(d: Delivery) { this.deliveries.set(`${d.eventId}|${d.adapter}`, d); }
  dead() { return [...this.deliveries.values()].filter((d) => d.state === "dead"); }
  /** Admin "retry" from the dead-letter view. */
  requeue(eventId: string, adapter: string) { const d = this.deliveries.get(`${eventId}|${adapter}`); if (d) Object.assign(d, { state: "pending", attempts: 0, nextAttemptAt: 0 }); }
}
