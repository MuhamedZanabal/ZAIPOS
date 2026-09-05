# P0 transaction map

Historical baseline originally inspected: `main` at `171d7d04a1627dead99c5d06a05f42dde69fb24a`.
Current production baseline after P0.6 implementation: `main` at `76ce641a847afa8fb94bad54b050fdcbde1aa682`.

## Baseline end-to-end path

| Stage | Current implementation | Persisted effect | Confirmed gap |
| --- | --- | --- | --- |
| Scan | `electron/services/barcode.ts` → `electron/preload.ts` → `useHardware` → `POS.tsx` | None | Scanner lookup matches the single `products.barcode` field; multiple barcodes do not exist. |
| Product resolution | `useProducts.ts`, `POS.tsx` branch availability and `product_channel_prices` overlay, Dexie product/branch caches | Product and branch-price cache | Cache stores decimal `price`; no fils field is consumed. |
| Cart | `stores/cart.ts` | Zustand memory only | Subtotal and tax are JavaScript floating-point calculations for UI preview; server checkout is authoritative. |
| Payment UI | `PaymentDialog.tsx` | None | Split/mixed payment UI is implemented for Cash, Card, BenefitPay and Bank Transfer. |
| Checkout client | `POS.tsx` → `buildPosCheckoutCommand` → `useOfflineMutation(CHECKOUT_SALE_V2)` | Online RPC or durable Dexie queue | Sends IDs/quantities/modifiers, exact discount/tip/payment fils, session ID and stable operation ID; does not send price/tax authority. |
| Checkout server | `checkout_sale_v2` | One database transaction creates sale/items/payments, changes stock/session totals, operation evidence and audit | Server resolves current price/tax and requires exact payment equality. True simultaneous multi-connection stock-contention coverage remains open. |
| Sale rows | `sales`, `sale_items`, `payments` | Historical sale snapshot plus allocations | Core checkout money has fils sidecars/parity and v2 commands use exact fils; wider application/server money cutover remains incomplete. |
| Inventory | checkout/return/void commands → `apply_inventory_movement` | `inventory_stocks` plus append-only `inventory_movements` | Checkout/return/void effects are operation-keyed; a universal exactly-once invariant across every inventory mutation class remains open. |
| Cash session | checkout, return and void update per-method buckets; `close_cash_session` reconciles exact sidecars | `cash_sessions` | P0.6 close path is production-verified and fils-authoritative; wider cash-operation hardening remains part of later global mutation review. |
| Receipt | committed sale fetched in `POS.tsx` → `useHardware` → Electron printer | Printed receipt | Split allocations are printed; historical reprint fidelity/audit remains a later gap. |
| Offline replay | `useOfflineMutation.ts` → Dexie `sync_queue` → `useSyncEngine.ts` | Durable six-state queue and committed result evidence | Checkout replay/state matrix is implemented; other mutation families are not all offline-enabled. |

## P0 transaction invariants and evidence

| Invariant | Current evidence | State after P0.6 implementation merge |
| --- | --- | --- |
| Payment allocations equal committed sale total | `checkout_sale_v2` exact integer-fils equality | Verified |
| Transaction money uses exact fils | Shared TypeScript kernel, Stage A/B parity, fils-native checkout/return/void/close calculations | Verified for transaction core; wider money surfaces remain |
| Sale changes inventory once | Checkout operation idempotency and transaction tests | Verified for checkout path; universal inventory mutation gate remains |
| Refund cannot exceed remainder | `process_sale_return_v2` cumulative item quantity and exact merchandise-value ceilings | Production verified |
| Return/void payment compensation is exact | Relational `payment_refunds`/`payment_voids` with original-allocation fils | Production verified |
| Return/void cannot duplicate stock/till effects | Stable operation IDs, sale row locking, unique effect keys and regression harnesses | Production verified |
| Tenant/branch compensation evidence is isolated | Branch-role RLS plus SELECT-only authenticated grants on return/void ledgers | Production verified |
| Customer loyalty is never guessed during compensation | Customer-linked return/void fails closed until exact immutable loyalty award evidence exists | Production verified fail-closed boundary |
| Composite reversal does not use mutable current recipes | Composite return/void fails closed without historical component snapshots | Production verified fail-closed boundary |
| Register closing reconciles to the fils | `close_cash_session` computes from exact sidecars, rejects >3-decimal counts and audits expected/count/difference fils | Production verified |
| Sensitive mutations are fully audited | Checkout, return, void and cash close emit audit evidence | Partial globally; complete mutation-family audit contract remains open |

## Production state after P0.4

Verified on `main` at `fe512eca9b3e62597761696fdbbbbb6777e35373` with post-merge CI run 117.

| Stage | Production path | Verified effect | Remaining P0 gap |
| --- | --- | --- | --- |
| Payment UI | `PaymentDialog.tsx` → `PaymentAllocation[]` | Cash, Card, BenefitPay and Bank Transfer can be combined with exact Allocated/Remaining fils; cash over-tender shows change. | Payment references are not yet captured by the cashier UI. |
| Checkout client | `POS.tsx` → `buildPosCheckoutCommand` → `useOfflineMutation(CHECKOUT_SALE_V2)` | Sends product/quantity/modifier IDs, exact discount/tip/payment fils, cash-session ID and UUID operation ID; sends no unit price or tax authority. | Wider mutation families are not all on the same durable offline lifecycle. |
| Checkout server | `checkout_sale_v2` | Server resolves product price and tax, validates tenant/branch/session/payment equality, and atomically persists sale, payments, stock, till totals, operation and audit. | Full concurrent multi-connection stock-conflict coverage remains open. |
| Payment persistence | `payments` and `cash_sessions` | One row per allocation; only the matching cash/card/qr/transfer till bucket changes; replay does not duplicate rows or bucket totals. | None within P0.4; compensation is covered by P0.6. |
| Receipt/hardware | committed sale lookup → `printTicket` / `openDrawer` | Receipt lists every allocation; any cash allocation requests the drawer; hardware runs after commit. | Historical reprint fidelity and reprint audit remain open. |

## Production state after P0.6

Implementation PR #12 (`feat/transaction-lifecycle`) was squash-merged as `76ce641a847afa8fb94bad54b050fdcbde1aa682`. Post-merge `main` CI 163 passed the full transaction/RLS/cash/lint/Vitest/build gate.

1. **Return/refund** — `Sales.tsx` → `ReturnDialog.tsx` → `process_sale_return_v2`.
   - Manager/owner/admin authorization and branch/session validation are server-side.
   - Original `sales`, `sale_items` and `payments` remain immutable.
   - `sale_returns`, `sale_return_items` and `payment_refunds` record relational compensation evidence.
   - Refund value is allocated from original committed merchandise/payment fils; tip remains non-refundable.
   - Partial returns converge exactly and cannot exceed original item quantity or merchandise value.
   - Stock restoration and current-session payment-bucket compensation are exactly once.
   - UI reads authoritative completed return ledgers for remaining quantity/value.
   - Customer-linked returns fail closed until exact immutable loyalty-award evidence exists.

2. **Void** — `Sales.tsx` → `VoidSaleDialog.tsx` → `process_sale_void_v2`.
   - Only uncompensated `completed` sales are eligible.
   - In-person void requires the same still-open original cash session.
   - `sale_voids`, `sale_void_items` and `payment_voids` record compensation evidence.
   - All original payment allocations, including tip in total tender, are reversed exactly from the original session buckets.
   - Inventory is restored exactly once and coupon usage is restored exactly once.
   - Customer-linked and composite sales fail closed when historical reversal evidence is insufficient.

3. **Evidence access** — all six return/void compensation tables are RLS-enabled, owner/admin/manager branch-scoped, and SELECT-only for authenticated clients; direct INSERT/UPDATE/DELETE is denied.

4. **Cash close** — the existing `close_cash_session` RPC signature is preserved, but reconciliation is performed from exact integer-fils sidecars. Counted values with more than three decimal places or negative counts are rejected. Audit metadata records exact expected cash, expected total, counted total and difference in fils.

Verification chain: return/refund RED 127 → GREEN 129; return UI through 137; void RED 140 → GREEN 141; void UI through 144; loyalty-safety RED 147/149 → GREEN 150; access hardening RED 156 → GREEN 157; cash close RED 159 → GREEN 160; final reviewed branch CI 162; implementation merge `76ce641a847afa8fb94bad54b050fdcbde1aa682`; post-merge `main` CI 163.
