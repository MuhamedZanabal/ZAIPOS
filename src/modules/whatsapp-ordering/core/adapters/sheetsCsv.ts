import type { OrderSyncAdapter } from "../outbox";
import type { OrderEvent } from "../types";
import { quote } from "../pricing";

export const CSV_HEADER = "event_key,at,order_number,status,from_status,actor,fulfilment,payment,total_bhd,items,chat";
const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function csvRow(e: OrderEvent): string {
  const q = quote(e.order.lines, e.order.deliveryFeeFils);
  const items = e.order.lines.map((l) => `${l.qty}x ${l.nameEn}`).join("; ");
  return [e.key, e.at, e.order.orderNumber, e.to, e.from, e.actor, e.order.fulfilment, e.order.paymentMethod, (q.totalFils / 1000).toFixed(3), items,
    e.order.chatId.replace(/@.*/, "").replace(/\d(?=\d{4})/g, "•")].map(esc).join(",");
}

/**
 * Simplest possible sheet sync: append one row per event to a CSV file (open it in Excel/Google Sheets),
 * or POST the row to a Google Apps Script web-app URL that appends it to a Sheet. Idempotent on event key.
 */
export class SheetsCsvAdapter implements OrderSyncAdapter {
  readonly name = "sheets_csv";
  constructor(private io: { readKeys(): Promise<Set<string>>; append(line: string, header: string): Promise<void> }) {}
  async onEvent(e: OrderEvent) {
    if ((await this.io.readKeys()).has(e.key)) return;
    await this.io.append(csvRow(e), CSV_HEADER);
  }
  async health() { return { ok: true }; }
}
