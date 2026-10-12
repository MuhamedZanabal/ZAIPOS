import { createHmac } from "node:crypto";
import { PermanentSyncError, type OrderSyncAdapter } from "../outbox";
import type { OrderEvent } from "../types";
import type { FetchLike } from "../llm";

export function signBody(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Generic signed webhook for any backend (ERP, BI, Zapier...). Receiver verifies X-ZAIPOS-Signature and dedupes on Idempotency-Key. */
export class WebhookAdapter implements OrderSyncAdapter {
  constructor(readonly name: string, private url: string, private secret: string, private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private now: () => number = Date.now) {}
  async onEvent(e: OrderEvent) {
    const body = JSON.stringify({ id: e.key, type: e.type, from: e.from, to: e.to, version: e.version, actor: e.actor, at: e.at, order: e.order });
    const ts = String(Math.floor(this.now() / 1000));
    const res = await this.fetchImpl(this.url, { method: "POST", body, headers: { "Content-Type": "application/json",
      "Idempotency-Key": e.key, "X-ZAIPOS-Timestamp": ts, "X-ZAIPOS-Signature": `v1=${signBody(this.secret, ts, body)}` } });
    if (res.ok || res.status === 409) return; // 409 = receiver already has it
    if (res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status)) throw new PermanentSyncError(`webhook ${res.status}`);
    throw new Error(`webhook ${res.status}`);
  }
  async health() { return { ok: !!this.url && !!this.secret }; }
}
