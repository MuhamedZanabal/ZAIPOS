# P0 Transaction Core Hardening Plan

**Goal:** Make ZAIPOS checkout and transaction lifecycle exact, idempotent, auditable, replay-safe, and Bahrain-money correct before adding broader feature parity.

## Non-negotiable invariants

1. `SUM(payments_fils) = sale_total_fils` for every paid POS/table sale.
2. One `client_mutation_id` can create at most one committed checkout effect.
3. Replaying the same checkout request returns the original sale and cannot duplicate stock, payments, coupon usage, loyalty or cash-session totals.
4. Reusing the same mutation ID with a materially different request is rejected.
5. Transaction money is quantized to fils (`1 BHD = 1000 fils`) before arithmetic or comparison.
6. No negative payment allocation, quantity, tax base, tip, discount or sale total is accepted.
7. Server-side checkout is authoritative for product existence, tenant/branch scope and transactional validation.
8. Hardware failure after sale commit never causes checkout replay.
9. Void/refund operations are role-authorized, reasoned, immutable and exactly-once.
10. Offline queue replay preserves the original mutation identity.

## Task 1 — Exact client money kernel

**Files**
- Create `src/lib/money.ts`
- Create `src/lib/money.test.ts`
- Update `src/lib/bahrain.ts` to delegate monetary rounding to the money kernel where appropriate.

**Acceptance**
- Deterministic conversion between BHD and integer fils.
- Three-decimal quantization.
- Exact addition/subtraction/percentage helpers operate on integer fils.
- Invalid/unsafe monetary inputs are rejected rather than silently coerced.

## Task 2 — Payment allocation model

**Files**
- Create `src/modules/pos/paymentAllocations.ts`
- Create `src/modules/pos/paymentAllocations.test.ts`
- Update `src/modules/pos/PaymentDialog.tsx`
- Update `src/modules/pos/POS.tsx`

**Acceptance**
- Checkout accepts one or more allocations across Cash, Card, BenefitPay and Bank Transfer.
- Allocation sum must exactly equal payable total in fils.
- Cash tender/change are display concerns; persisted cash payment is the sale allocation, not cash tendered.
- No zero/negative/over-allocation can be confirmed.

## Task 3 — Stable checkout operation identity

**Files**
- Update `src/modules/pos/POS.tsx`
- Update `src/hooks/useOfflineMutation.ts`
- Update `src/hooks/useOfflineMutation.test.ts`
- Update `src/hooks/useSyncEngine.test.ts`

**Acceptance**
- Mutation ID is generated before first network attempt and retained across queue/replay.
- An ambiguous/transient failure cannot create a second identity for the same submitted checkout.
- Device storage key uses ZAIPOS identity while preserving compatibility with an existing legacy device ID if present.

## Task 4 — Race-safe server checkout

**Files**
- Create migration `supabase/migrations/20260905000100_transaction_core_foundation.sql`

**Schema**
- Add `checkout_operations` keyed by `(tenant_id, client_mutation_id)` with request payload, status, sale ID, actor and timestamps.
- Add exact fils shadow columns/checks for sale/payment/cash-session transaction totals where safe and backfill existing records.
- Add supporting indexes/constraints.

**RPC**
- Replace `checkout_sale` with a version that:
  - requires stable mutation identity for POS/table transactions;
  - claims idempotency race-safely;
  - rejects mutation-ID payload mismatch;
  - quantizes all monetary arithmetic to fils;
  - validates exact payment equality;
  - validates positive payment allocations and known methods;
  - locks relevant checkout/session rows where needed;
  - writes one operation result only after all effects succeed;
  - returns the original sale for exact replay.

## Task 5 — Transaction-core static migration gate

**Files**
- Create `scripts/audit-transaction-core.mjs`
- Add `audit:transactions` to `package.json`
- Add CI step before tests/build.

**Acceptance**
- CI fails if the latest checkout migration loses the idempotency table/unique key, fils conversion, exact payment equality, or payload mismatch guard.

## Task 6 — Void transaction lifecycle

**Files**
- Add migration `20260905000110_sale_void_transaction.sql`
- Update Sales UI with a role-gated Void action only after RPC exists.

**Acceptance**
- Only owner/admin/manager may void.
- Completed sale only; reason required.
- Exactly-once void operation ID.
- Inventory and cash-session/payment accounting effects are reversed with compensating records/updates.
- Original sale and payments remain immutable/readable; status/void metadata records the reversal.
- Second identical void returns prior result; conflicting reuse is rejected.

## Task 7 — Refund/return invariants

**Files**
- Audit existing returns RPC/schema and `ReturnDialog`.
- Add a forward migration rather than rewriting migration history.
- Add tests/static gates for maximum refundable quantity/value, idempotency and stock/payment/cash consistency.

## Task 8 — Offline/retry failure matrix

**Tests**
- Offline before first request.
- Transient failure before server commit.
- Ambiguous failure after server commit followed by replay.
- App restart with queued checkout.
- Duplicate queue processing.
- Retry limit handling without identity mutation.

## Task 9 — Full verification gate

Required before merge:
- localization audit
- migration validation
- transaction-core audit
- lint
- full Vitest suite
- production build
- PR branch must be zero commits behind `main`

`main` is not updated until all gates pass.