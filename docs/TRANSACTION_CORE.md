# ZAIPOS Transaction Core

## Scope

This document defines the production transaction contract introduced by the P0 exact-money and atomic-checkout programme. It is intentionally narrower than the full POS roadmap: split-payment UI, the expanded offline failure-state machine, refunds/voids, concurrency stress coverage, and release infrastructure remain separate programme items until independently verified.

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

## Installed-client compatibility

`public.checkout_sale` remains available temporarily for already-installed POS builds that still send decimal-shaped checkout payloads.

Migration `20260905033000_checkout_sale_v2_compat.sql` turns that RPC into a compatibility adapter. The adapter:

- discards client price and tax values;
- converts legacy BHD discounts, tips, and payment amounts to exact fils;
- requires an unambiguous open branch cash session for POS/table checkout unless the existing dev-mode exception applies;
- preserves a supplied client mutation ID;
- delegates the financial transaction to `checkout_sale_v2`.

The adapter is a migration bridge, not a second transaction engine. New client work should target `checkout_sale_v2` through the fils-native payload builder.

## Offline replay compatibility

The local queue distinguishes new `CHECKOUT_SALE_V2` operations from historical `CHECKOUT_SALE` entries.

- `CHECKOUT_SALE_V2` replays through `checkout_sale_v2` without payload rewriting.
- Existing `CHECKOUT_SALE` entries retain their legacy RPC route so already-persisted operations are not corrupted by a queue-format migration.

A later P0 slice will expand queue states and stale-operation review handling for the full offline failure matrix.

## Verification contract

`scripts/test-atomic-checkout-v2.mjs` executes the exact-money migrations, `checkout_sale_v2`, and the installed-client compatibility migration against an executable PostgreSQL-compatible PGlite fixture.

The contract covers:

- BHD 1.025 + 10% VAT = 1128 fils;
- malicious/stale client price and tax are ignored;
- exact split allocation persistence at the database command layer;
- one-fils payment mismatch rejection;
- cross-tenant customer rejection;
- closed-session rejection;
- unauthorized actor rejection;
- identical replay returning the original sale;
- changed payload under the same operation ID being rejected;
- exactly one stock movement per committed sale;
- exactly-once payment/stock effects on replay;
- audit event emission;
- installed-client decimal payload delegation to the same v2 transaction engine;
- ambiguous multiple-open-session rejection by the compatibility adapter.

## Remaining P0 transaction work

The following are not declared complete by this document:

- native split/mixed-payment cashier UI;
- cash over-tender/change rules in the server payment-allocation model;
- full offline failure matrix and explicit `requires_review` lifecycle;
- multi-client concurrency/stock-conflict stress tests;
- server-authoritative void/return/refund lifecycle;
- end-to-end scan → pay → receipt → stock verification across the production client;
- receipt historical reprint fidelity.
