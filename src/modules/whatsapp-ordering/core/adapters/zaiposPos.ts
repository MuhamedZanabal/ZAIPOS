import { PermanentSyncError, type OrderSyncAdapter } from "../outbox";
import type { OrderEvent } from "../types";

/**
 * ZAIPOS POS/KDS + inventory. Calls one SECURITY DEFINER function, wa_sync_order_to_pos(event jsonb),
 * which upserts the digital_orders row (channel 'whatsapp'), its items, the delivery_orders row, and
 * records the event key so a replay is a no-op. On DELIVERED/PICKED_UP it books the sale through the
 * existing confirm path so stock is decremented exactly once.
 */
export type SqlCall = (fn: string, args: unknown[]) => Promise<unknown>;
export class ZaiposPosAdapter implements OrderSyncAdapter {
  readonly name = "zaipos_pos";
  constructor(private call: SqlCall) {}
  async onEvent(e: OrderEvent) {
    try {
      await this.call("wa_sync_order_to_pos", [JSON.stringify(e)]);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // Validation failures (e.g. product deleted) will never succeed by retrying.
      if (/not found|invalid|violates check/i.test(msg)) throw new PermanentSyncError(msg);
      throw err;
    }
  }
  async health() {
    try { await this.call("wa_sync_health", []); return { ok: true }; } catch (e) { return { ok: false, detail: String(e) }; }
  }
}
