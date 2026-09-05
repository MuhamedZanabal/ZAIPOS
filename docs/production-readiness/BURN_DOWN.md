# ZAIPOS production programme burn-down

This inventory is evidence-based. An unchecked item may have partial or branch-verified code but still lacks one or more required database, authorization, failure, test, documentation, CI, merge or post-merge proofs.

## Baseline controls

- [x] Current production implementation baseline before P0.6 verified from `main`: `3ca52663c98e1f5bad03861249cd0edd9f62e1f3`
- [x] Repository, migrations, CI, package configuration, checkout path, money kernel and automated transaction tests inspected
- [x] Scan-to-receipt and offline replay path mapped
- [ ] Full database migration chain executed on clean and supported-upgrade production-shaped databases
- [ ] Protected `main` with required checks

## P0 transaction core

- [x] Exact-fils TypeScript kernel with boundary tests
- [x] Pure split-payment, till-cash and refund-ceiling invariant tests
- [x] Exact-money Stage A: core BIGINT fils sidecars, backfill, synchronization, parity constraints and restricted diagnostics
- [x] Exact-money Stage B: legacy monetary compatibility columns widened losslessly to three-decimal BHD precision, with parity diagnostics preserved
- [ ] Remaining money-bearing ledger fields inventoried and given exact authoritative representations where required
- [ ] Integer-fils authoritative application/server cutover for all remaining money surfaces
- [x] Server-authoritative atomic validate/commit checkout through `checkout_sale_v2`
- [x] Split-payment UI and exact server persistence for Cash, Card, BenefitPay and Bank Transfer
- [x] Concurrent/idempotent checkout replay returns the original result and rejects local operation-ID payload conflicts
- [x] Explicit offline queue state/failure matrix with durable commit evidence, crash recovery, tenant isolation and operator review states
- [ ] Exactly-once inventory operation constraint and integration tests across all inventory mutation classes
- [ ] Void command — P0.6 branch implementation is green; production merge/post-merge proof still required
- [ ] Cumulative partial-refund ceiling and compensating payment records — P0.6 branch implementation is green; production merge/post-merge proof still required
- [ ] Cash/refund/void close-reconciliation invariants in the database — P0.6 branch implementation is green; production merge/post-merge proof still required
- [ ] Tenant and branch relational consistency constraints/tests across the wider schema
- [ ] Complete sensitive-mutation audit contract across all mutation families
- [ ] POS transaction E2E and true simultaneous stock-concurrency tests

### P0.5 verification evidence

- Implementation PR: #10 (`feat/offline-checkout-replay`)
- Final reviewed PR head: `6dd95e537c0acfe2cec201970d8937621d8f3766`
- RED CI 121: proved operation-ID payload-conflict and concurrent local enqueue defects before the fix
- Final branch CI 123: green; 48 migrations, exact-money contract, atomic/stale checkout contract, checkout-operation RLS, lint, full Vitest suite and production build passed
- Squash merge: `98ba7a07495be218128b351879ea864002b26453`
- Post-merge `main` CI 124: green
- Evidence merge: `3ca52663c98e1f5bad03861249cd0edd9f62e1f3`
- Final evidence CI 126: green
- Scope boundary: true simultaneous multi-connection stock contention remains part of the later P0 concurrency gate

### P0.6 branch verification evidence — pending production merge

Implementation PR: #12 (`feat/transaction-lifecycle`). The following evidence is branch-level and must not be interpreted as production-complete until PR #12 is merged and the exact merge SHA passes `main` CI.

- Return/refund RED CI 127 exposed the missing exact lifecycle contract.
- Return/refund database GREEN CI 129 proved exact fils, cumulative quantity/value ceilings, proportional original-payment compensation, manager authorization, idempotency, exactly-once stock/till effects and immutable original financial history.
- Return UI RED/green cycles culminated in CI 137, proving native `process_sale_return_v2`, authoritative remaining refundable fils, authoritative remaining line quantities and repeat partial-return operability.
- Void RED CI 140 proved the command was absent before implementation.
- Void server GREEN CI 141 proved exact split-payment/till compensation, exactly-once stock restoration, coupon reversal, manager/session authorization, immutable original history, idempotency and fail-closed composite/customer cases.
- Void UI RED/green cycles culminated in CI 144 with live Sales/VoidSaleDialog wiring.
- Customer-linked return loyalty-safety RED CI 147/149 and GREEN CI 150 prove customer returns fail closed until immutable exact loyalty-award reversal evidence exists.
- Return/void evidence-access RED CI 156 and GREEN CI 157 prove owner/admin/manager branch-scoped reads and denial of direct authenticated insert/update/delete on all six compensating ledgers.
- Cash close RED CI 159 and GREEN CI 160 prove sub-fils input rejection, exact integer-fils expected/count/difference reconciliation, branch authorization, exact audit evidence and repeat-close rejection against a net mixed sale/return/void session state.
- Final branch head proven green before documentation-only updates: `ac187e7927533044d1ed2a6b376a50a52221fc79` (CI 160).
- Known intentional fail-closed boundaries: customer-linked compensation awaits immutable loyalty-award evidence; composite return/void awaits historical component snapshots.

## P0 release

- [ ] Signed Windows installer
- [ ] Versioned GitHub Release workflow
- [ ] Configured GitHub updater provider
- [ ] User-approved update download/install flow
- [ ] Stable/beta channels
- [ ] Device version/health registry
- [ ] Tested rollback procedure

## P0 AI safety

- [ ] Remove hard-coded product margins and unsupported AI findings from `AIAgent.tsx`
- [ ] Remove artificial retrieval behavior from the operational AI surface
- [ ] Source-backed read-only controller and initial tool policy
- [ ] Evidence metadata and server-side role enforcement

## P1/P2/P3

All downstream catalogue, inventory lot, stocktake, supplier/customer ledger, reporting, AI action, alert, price-intelligence, OCR, WhatsApp and optional LAN-resilience capabilities remain unchecked until their complete definition-of-done evidence exists.
