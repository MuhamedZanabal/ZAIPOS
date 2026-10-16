import type { OrderSyncAdapter } from "../outbox";
import type { Lang, OrderEvent, OrderStatus } from "../types";
import { M } from "../messages";

const NOTIFY: OrderStatus[] = ["CONFIRMED","ACCEPTED","PREPARING","OUT_FOR_DELIVERY","READY_FOR_PICKUP","DELIVERED","PICKED_UP","CANCELLED","REJECTED","FAILED_DELIVERY"];

/** Sends the customer a WhatsApp update on every status change, in their language. Dedupe key = event key. */
export class CustomerNotifierAdapter implements OrderSyncAdapter {
  readonly name = "whatsapp_customer";
  constructor(private deps: { langOf(chatId: string): Promise<Lang>; optedOut(chatId: string): Promise<boolean>;
    enqueue(chatId: string, text: string, dedupeKey: string): Promise<void> }) {}
  async onEvent(e: OrderEvent) {
    if (!NOTIFY.includes(e.to)) return; // READY on a delivery order is internal; customer hears OUT_FOR_DELIVERY
    if (await this.deps.optedOut(e.order.chatId)) return;
    await this.deps.enqueue(e.order.chatId, M.status(await this.deps.langOf(e.order.chatId), e.order), `notify:${e.key}`);
  }
  async health() { return { ok: true }; }
}
