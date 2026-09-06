# ZAIPOS Transaction Core

## Scope

This document defines the currently verified P0 transaction contract for exact money, atomic checkout, split payments, offline replay, compensation transactions, cash-session close, and client-facing inventory mutation authority.

It does **not** declare the complete application production-ready. True simultaneous multi-connection stock contention, full migration-chain upgrade testing, wider relational tenant/branch consistency, global mutation-audit coverage, POS end-to-end verification, release infrastructure, and AI safety remain independent gates.

## Money authority

ZAIPOS transactional money uses exact integer fils as the authoritative representation wherever a `*_fils` field is available.

- BHD 1.000 = 1000 fils
- BHD 0.025 = 25 fils
- BHD 1.025 = 1025 fils

Legacy decimal compatibility columns remain during the staged migration and are widened to three-decimal BHD precision. The Stage A/B parity layer keeps decimal and fils values aligned while downstream code migrates to fils-native operations.

## Atomic checkout command

`public.checkout_sale_v2` is the hardened server-authoritative checkout command.

The command:

1. authenticates the actor and enforces branch-role authorization;
2. verifies tenant/branch/customer/cash-session scope;
3. requires a non-empty item list and payment list;
4. resolves active product, branch, and channel pricing on the server;
5. resolves tax from persisted product configuration rather than client-supplied tax;
6. calculates line, discount, tip, tax, subtotal, and total values in integer fils;
7. requires payment allocations to reconcile exactly to the committed sale total;
8. commits sale, sale lines, payments, inventory effects, till payment buckets, operation state, and audit evidence atomically;
9. uses `(tenant_id, client_mutation_id)` as the exactly-once financial-operation identity;
10. returns the original sale for an identical replay and rejects reuse of the same operation ID with a different request payload.

Client-supplied `unit_price`, `unit_price_fils`, and `tax_rate` values are not authoritative checkout inputs.

## Split and mixed payments

The cashier uses exact fils allocations across:

- Cash
- Card
- BenefitPay (`qr` database payment bucket)
- Bank Transfer (`transfer` database payment bucket)

Non-cash allocations may not exceed the remaining payable amount. Cash may be over-tendered, but only the remaining sale amount is persisted and the excess is reported as customer change. Completion requires persisted allocations to reconcile exactly to the committed payable total.

Receipts preserve separate allocations and the cash drawer is requested whenever any committed allocation is cash.

## Installed-client compatibility

`public.checkout_sale` remains available temporarily for already-installed POS builds that still send decimal-shaped checkout payloads.

Migration `20260905033000_checkout_sale_v2_compat.sql` turns that RPC into a compatibility adapter. The adapter:

- discards client price and tax values;
- converts legacy BHD discounts, tips, and payment amounts to exact fils;
- requires an unambiguous open branch cash session for POS/table checkout unless the existing dev-mode exception applies;
- preserves a supplied client mutation ID;
- delegates the financial transaction to `checkout_sale_v2`.

The adapter is a migration bridge, not a second transaction engine. New client work targets the v2 transaction path.

## Offline replay lifecycle

The financial queue has an explicit durable lifecycle:

- `queued`
- `sending`
- `committed`
- `retrying`
- `failed`
- `requires_review`

`CHECKOUT_SALE_V2` operations replay through `checkout_sale_v2` without payload rewriting. Already-persisted historical `CHECKOUT_SALE` entries retain their compatibility route.

The queue preserves the same stable checkout operation identity across response loss, restart, and retry. A committed result is retained as durable evidence rather than immediately deleting the operation. Reuse of the same operation ID with a different payload is rejected. Deterministic stale business-state conflicts are routed to operator review, and unknown operation types are retained instead of silently discarded.

## Return and refund compensation

`process_sale_return_v2` is a compensating transaction, not a destructive rewrite of the original sale.

The verified contract includes:

- exact integer-fils refund accounting;
- cumulative partial-return quantity and value ceilings;
- discount-aware merchandise allocation with tip excluded from refundable merchandise value;
- proportional compensation across original Cash/Card/BenefitPay/Bank Transfer allocations;
- exactly-once inventory restoration and current-session till compensation;
- stable operation-ID replay and changed-payload rejection;
- branch authorization and exact in-person cash-session binding;
- immutable original sale, item, and payment history;
- branch-scoped return evidence and direct compensation-ledger mutation denial.

Customer-linked returns deliberately fail closed until immutable exact loyalty-award reversal evidence is available.

## Void compensation

The hardened void command compensates an eligible completed sale without deleting its original financial history.

The verified contract includes:

- same-session authorization for in-person voids;
- exact reversal of every original payment allocation and till bucket;
- exactly-once inventory restoration;
- coupon-use reversal;
- stable operation-ID replay and mismatch protection;
- relational void/payment compensation evidence;
- immutable original sale/item/payment rows;
- branch-scoped evidence access.

Composite sale compensation deliberately fails closed where historical component-consumption snapshots are insufficient for deterministic reversal.

## Cash-session close

The production close command reconciles from exact cash-session fils sidecars.

It:

- rejects negative and sub-fils counted amounts;
- derives exact expected/count/difference values;
- includes exact sale/return/void net payment buckets;
- enforces branch authorization;
- records audit evidence;
- rejects repeat close of an already-closed session.

## Inventory operation authority

Client-facing inventory mutations are now owned by server commands and an exactly-once operation ledger rather than direct invocation of the low-level stock primitive.

`public.inventory_operations` binds `(tenant_id, client_mutation_id)` to a canonical request payload. Identical completed replay returns the original operation. Reuse of the same mutation ID for a different request is rejected.

Verified commands include:

- `record_inventory_batch_v2` — atomic manual, OCR, and EAN inventory batches;
- `transfer_inventory_v2` — one replay-safe transfer operation owning source and destination effects;
- `receive_purchase_order_v2` — row-locked purchase-order status plus stock receipt in one transaction;
- `complete_production_order_v2` — row-locked production completion owning ingredient consumption, production-consumption evidence, output stock, and completion state;
- `reconcile_inventory_levels_v2` — server-authoritative physical target reconciliation.

Authenticated clients may no longer execute `apply_inventory_movement` directly. Superseded public transfer and production-completion commands are also revoked from authenticated execution.

Restaurant table dispatch and undispatch lock the table-item state row before stock effects so two concurrent transitions cannot both observe the same pre-effect state and apply inventory twice.

## Physical inventory reconciliation

Bulk physical-stock import sends target quantities rather than browser-computed deltas.

For each product, `reconcile_inventory_levels_v2`:

1. validates tenant, branch, active inventory center, product, role, and three-decimal non-negative target quantity;
2. claims a stable inventory operation identity;
3. creates a zero stock row when one does not yet exist;
4. locks the current stock row;
5. computes `delta = target - committed_current_quantity` on the server;
6. sets stock exactly to the physical target;
7. writes a signed `adjustment` movement when the delta is non-zero;
8. records the operation as completed and emits audit evidence;
9. returns the original operation without repeating effects on identical replay.

This supports both positive and negative physical corrections without asking the legacy movement primitive to accept a negative input quantity.

## Verification contract

The production CI executes executable PostgreSQL-compatible PGlite contracts for:

- exact-money Stage A/B precision and fils parity;
- atomic checkout and installed-client compatibility;
- checkout-operation RLS;
- return/refund lifecycle;
- customer-return loyalty fail-closed behavior;
- void lifecycle;
- return/void evidence access and direct-mutation denial;
- exact cash-session reconciliation;
- inventory exactly-once commands;
- server-authoritative physical stock reconciliation;
- client inventory v2 cutover.

P0.7 implementation PR #15 was reviewed at head `131f97db04085ed18c31b44e086927480edfb4da`, passed branch CI 190, merged as `cb938bde406ebc7c36f7cea936d517a3dabb3c07`, and passed post-merge `main` CI 191.

## Remaining P0 transaction work

The following are **not** declared complete by this document:

- true simultaneous multi-connection checkout/stock-contention stress testing;
- full clean-install plus supported-upgrade migration-chain verification;
- wider tenant/branch relational consistency constraints;
- complete sensitive-operation authorization coverage across the full application;
- complete mutation-audit coverage across the full application;
- end-to-end scan → pay → receipt → stock verification across the production client;
- historical receipt reprint fidelity where not independently verified.
