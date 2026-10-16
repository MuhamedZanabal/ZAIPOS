# WhatsApp AI ordering & delivery (Evolution API)

Customers order over WhatsApp. The bot answers on its own; staff step in only when needed.

## Flow (all inside WhatsApp)
1. **Browse or ask** – `menu` → numbered categories → numbered items; or free text ("2 shawarma extra garlic and a karak", Gulf Arabic too).
2. **Cart** – add, remove, clear; sold-out and stock limits are checked straight away.
3. **Checkout** – `done` / `خلاص` → delivery or pickup → address or 📍 pin → payment (cash, BenefitPay, card on delivery) → summary with VAT.
4. **Confirm** – `yes`. Price and stock are re-checked; if anything changed, the customer gets a new quote and must confirm again.
5. **Status updates** – each staff/POS status change sends a WhatsApp message in the customer's language.
6. **Help / handoff** – `help`, `human`/`موظف`. The AI goes quiet until staff hand the chat back (`wa_set_handoff`). Asking to cancel after cooking starts also goes to staff.
7. **End** – DELIVERED / PICKED_UP / CANCELLED / REJECTED / FAILED_DELIVERY. `stop` opts out of all messages.

## State machine
`DRAFT → AWAITING_CONFIRMATION → CONFIRMED → ACCEPTED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED | FAILED_DELIVERY`
(pickup: `READY → READY_FOR_PICKUP → PICKED_UP`). The order can be cancelled from any state up to READY_FOR_PICKUP; customers can cancel only up to ACCEPTED.
One table (`stateMachine.ts`) mirrored in SQL (`wa_order_transitions`, checked by a test). Every change bumps `version`
(optimistic locking, so a stale staff/POS update is rejected) and writes an `order.status_changed` event to an outbox.

## Sync adapters (outbox)
Each event goes to each adapter independently, with retries: exponential backoff with jitter, a per-order ordering lane, dead-letter after max attempts, and an admin requeue (`wa_requeue_delivery`).
Idempotency key = `orderId:version`, so a replay does nothing.
- **ZAIPOS POS/KDS + inventory** – `wa_sync_order_to_pos` upserts `digital_orders` (channel `whatsapp`). A sale is booked, and stock taken, once, on DELIVERED/PICKED_UP. A cancel at the till syncs back via a trigger.
- **Webhook (ERP/any)** – HMAC-signed POST with an `Idempotency-Key`. 4xx = permanent failure, 5xx/network = retry.
- **Sheet/CSV** – adds one row per event, with the phone number masked.
- **Customer notifier** – the WhatsApp status messages above.
Conflict rule: the DB version wins. A writer with a stale version gets `VersionConflictError` and must re-read.

## Code map
`src/modules/whatsapp-ordering/core/`: `receiver.ts` (webhook HTTP handler), `evolution.ts` (payload parsing), `engine.ts`,
`parser.ts` + `llm.ts` (rules first, optional LLM limited to the catalog), `sender.ts` (Evolution client + throttle), `outbox.ts`, `adapters/`.
Migration: `supabase/migrations/20261012120000_whatsapp_ai_ordering.sql`. Tests: `__tests__/` (mock gateway only).
Transcripts: run `WA_SIM_DIR=<dir> npx vitest run src/modules/whatsapp-ordering`.

## Why Evolution API over WAHA
| | Evolution API | WAHA |
|---|---|---|
| License / cost | Apache-2.0, all features free | Core free; multi-session, some engines and features need **WAHA Plus** (paid) |
| ZAIPOS fit | Already integrated (`evolution-webhook`, `send-whatsapp-message`) | Would be new code |
| Multi-number | Many instances per server, free | Plus only |
| Engine | Baileys (WebSocket, no browser), light on RAM | WEBJS (headless Chrome, heavy) / NOWEB / GOWS |
| Extras | Built-in Postgres/Redis persistence, webhooks per event | Good dashboard and Swagger |
Choice: **Evolution API** because it's already wired into ZAIPOS, free for multiple branches, and light.
WAHA is a fine fallback: only `sender.ts` and `evolution.ts` would change.

## Implications of an unofficial gateway
- **Session keep-alive** – it is a linked device (WhatsApp Web protocol). The phone must stay on WhatsApp and online at least every ~14 days, or linked devices log out.
  Keep Evolution persistence (Postgres/Redis) on so restarts don't need a new QR scan. `connection.update` → `onSession` is the hook for alerting staff to re-scan when `needsQr`.
- **Rate limits** – WhatsApp publishes no limits for this route. Our defaults (`DEFAULT_THROTTLE`): ≥1.5 s between messages to the same chat, ≤20/min for the whole number,
  a typing indicator and human-like delay with jitter. Reply only to chats that messaged first; no bulk or cold messages.
- **Ban risk** – real, and not under our control. It breaks WhatsApp's Terms of Service, and a number can be restricted or banned without warning, especially if it's new, sends heavily, or gets reported.
  To reduce it: use an established **dedicated** business number (not the owner's personal one), make replies inbound-only, honour `stop`, keep volume low, and have a fallback (phone line, Talabat).
  The official Cloud API is the upgrade path if volume grows.
- **Self-hosted vs managed** – self-hosted (Docker on a small VPS, ~1 vCPU/1–2 GB, plus Postgres/Redis): cheap, the data stays with you, but you handle uptime, updates and TLS.
  Managed Evolution hosts are less work but put chat data and the session with a third party. Neither one lowers the ban risk.

## Assumptions (A#)
- A1 One WhatsApp number = one branch (`wa_ordering_settings.evolution_instance`).
- A2 Prices are VAT-exclusive; 10% VAT also applies to the delivery fee; flat delivery fee (default BHD 0.500); BHD to 3 decimals (fils integers).
- A3 Payment is collected on delivery/pickup (cash, card, or BenefitPay to the shop's number); no online payment capture.
- A4 One active order per chat; the customer can cancel themselves only until ACCEPTED, after that staff decide.
- A5 Delivery is done by the shop's own drivers; ETA is a set default (35 min) that staff can override.
- A6 Evolution cannot sign webhooks, so the receiver requires a shared secret (`x-webhook-token` header or `?token=`).
- A7 The LLM is optional; with no key, the rule parser handles everything. LLM output is always checked against the catalog.
- A8 Opt-out (`stop`) is honoured and only reversed when the customer opts in again.
- A9 No live WhatsApp traffic was tested; every test uses a mock gateway.

## Owner steps to go live
1. Deploy Evolution API (Docker) with persistence and an API key; create an instance and scan the QR with the dedicated number.
2. Apply the migration; insert a `wa_ordering_settings` row.
3. Host `receiveEvolutionWebhook` (Edge Function or a small Node worker, plus the outbox/sender workers) and point the Evolution webhook (events `MESSAGES_UPSERT`, `CONNECTION_UPDATE`) at it with the secret.
   Adding a new Edge Function changes the authorization census, so that needs the owner's sign-off as a separate change.
4. Pilot on one branch at low volume.
