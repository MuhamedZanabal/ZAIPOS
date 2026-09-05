# ZAIPOS production programme burn-down

This inventory is evidence-based. An unchecked item may have partial code but lacks one or more required database, authorization, failure, test, documentation, CI or post-merge proofs.

## Baseline controls

- [x] Current implementation baseline verified from `main`: `98ba7a07495be218128b351879ea864002b26453`
- [x] Repository, 48 migrations, CI, package configuration, checkout path, money kernel and existing automated tests inspected
- [x] Scan-to-receipt and offline replay path mapped
- [ ] Full database migration chain executed on clean and supported-upgrade production-shaped databases
- [ ] Protected `main` with required checks

## P0 transaction core

- [x] Exact-fils TypeScript kernel with boundary tests
- [x] Pure split-payment, till-cash and refund-ceiling invariant tests
- [x] Exact-money Stage A: core BIGINT fils sidecars, backfill, synchronization, parity constraints and restricted diagnostics
- [x] Exact-money Stage B: legacy monetary compatibility columns widened losslessly to three-decimal BHD precision, with parity diagnostics preserved
- [ ] Remaining money-bearing ledger fields inventoried and given exact authoritative representations where required
- [ ] Integer-fils authoritative application/server cutover
- [x] Server-authoritative atomic validate/commit checkout through `checkout_sale_v2`
- [x] Split-payment UI and exact server persistence for Cash, Card, BenefitPay and Bank Transfer
- [x] Concurrent/idempotent checkout replay returns the original result and rejects local operation-ID payload conflicts
- [x] Explicit offline queue state/failure matrix with durable commit evidence, crash recovery, tenant isolation and operator review states
- [ ] Exactly-once inventory operation constraint and integration tests
- [ ] Void command
- [ ] Cumulative partial-refund ceiling and compensating payment records
- [ ] Cash/refund invariants in the database
- [ ] Tenant and branch relational consistency constraints/tests
- [ ] Complete sensitive-mutation audit contract
- [ ] POS transaction E2E and stock concurrency tests

### P0.5 verification evidence

- Implementation PR: #10 (`feat/offline-checkout-replay`)
- Final reviewed PR head: `6dd95e537c0acfe2cec201970d8937621d8f3766`
- RED CI 121: proved operation-ID payload-conflict and concurrent local enqueue defects before the fix
- Final branch CI 123: green; 48 migrations, exact-money contract, atomic/stale checkout contract, checkout-operation RLS, lint, 99/99 Vitest tests and production build passed
- Squash merge: `98ba7a07495be218128b351879ea864002b26453`
- Post-merge `main` CI 124: green
- Scope boundary: true simultaneous multi-connection stock contention remains part of the P0.7 concurrency gate

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
