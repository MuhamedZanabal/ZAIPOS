# ZAIPOS production programme burn-down

This inventory is evidence-based. An unchecked item may have partial or branch-verified code but still lacks one or more required database, authorization, failure, test, documentation, CI, merge or post-merge proofs.

## Baseline controls

- [x] Current P0 complete-all implementation baseline verified from `main`: `6ad10038f5f12471a0ca252c52df3b0dafc1c669`
- [x] Repository, migrations, CI, package configuration, checkout path, money kernel and automated transaction tests inspected
- [x] Scan-to-receipt and offline replay path mapped
- [x] Full database migration chain executed on clean and supported-upgrade production-shaped databases
- [ ] Protected `main` with required checks — external repository-admin permission required

## P0 transaction core

- [x] Exact-fils TypeScript kernel with boundary tests
- [x] Pure split-payment, till-cash and refund-ceiling invariant tests
- [x] Exact-money Stage A: core BIGINT fils sidecars, backfill, synchronization, parity constraints and restricted diagnostics
- [x] Exact-money Stage B: legacy monetary compatibility columns widened losslessly to three-decimal BHD precision, with parity diagnostics preserved
- [x] Remaining P0 money-bearing transaction fields inventoried and given exact authoritative representations
- [x] Integer-fils authoritative P0 application/server transaction cutover
- [x] Server-authoritative atomic validate/commit checkout through `checkout_sale_v2`
- [x] Split-payment UI and exact server persistence for Cash, Card, BenefitPay and Bank Transfer
- [x] Concurrent/idempotent checkout replay returns the original result and rejects local operation-ID payload conflicts
- [x] Explicit offline queue state/failure matrix with durable commit evidence, crash recovery, tenant isolation and operator review states
- [x] Exactly-once inventory operation constraint and integration tests across P0 inventory mutation classes
- [x] Void command with exact compensating payment, inventory, coupon and till effects
- [x] Cumulative partial-refund ceiling with exact compensating payment records and immutable original history
- [x] Cash/refund/void close-reconciliation invariants in the database
- [x] Tenant and branch relational consistency constraints/tests across the wider schema
- [x] Complete P0 sensitive-mutation audit contract across transaction mutation families
- [x] POS transaction E2E and true simultaneous stock-concurrency tests

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

### P0.6 production verification evidence

- Implementation PR: #12 (`feat/transaction-lifecycle`)
- Return/refund RED CI 127 exposed the missing exact lifecycle contract.
- Return/refund database GREEN CI 129 proved exact fils, cumulative quantity/value ceilings, proportional original-payment compensation, manager authorization, idempotency, exactly-once stock/till effects and immutable original financial history.
- Return UI RED/green cycles culminated in CI 137, proving native `process_sale_return_v2`, authoritative remaining refundable fils, authoritative remaining line quantities and repeat partial-return operability.
- Void RED CI 140 proved the command was absent before implementation.
- Void server GREEN CI 141 proved exact split-payment/till compensation, exactly-once stock restoration, coupon reversal, manager/session authorization, immutable original history, idempotency and fail-closed composite/customer cases.
- Void UI RED/green cycles culminated in CI 144 with live Sales/VoidSaleDialog wiring.
- Customer-linked return loyalty-safety RED CI 147/149 and GREEN CI 150 prove customer returns fail closed until immutable exact loyalty-award reversal evidence exists.
- Return/void evidence-access RED CI 156 and GREEN CI 157 prove owner/admin/manager branch-scoped reads and denial of direct authenticated insert/update/delete on all six compensating ledgers.
- Cash close RED CI 159 and GREEN CI 160 prove sub-fils input rejection, exact integer-fils expected/count/difference reconciliation, branch authorization, exact audit evidence and repeat-close rejection against a net mixed sale/return/void session state.
- Final reviewed branch head: `4cb0cd2a2419227edd9601aad0b58fc71a8dea7f`.
- Final branch CI 162: green across migration validation, exact money, checkout, checkout RLS, return/refund, loyalty guard, void, return/void access, cash reconciliation, lint, full Vitest and production build.
- Squash merge: `76ce641a847afa8fb94bad54b050fdcbde1aa682`.
- Post-merge `main` CI 163: green on the exact implementation merge SHA.
- Known intentional fail-closed boundaries: customer-linked compensation awaits immutable loyalty-award evidence; composite return/void awaits historical component snapshots.

## P0 release

- [ ] Signed Windows installer — external certificate credentials required
- [x] Versioned GitHub Release workflow
- [x] Configured GitHub updater provider
- [x] User-approved update download/install flow
- [x] Stable/beta channels
- [x] Device version/health registry
- [x] Controlled rollback procedure and known-good release retention documented

## P0 AI safety

- [x] Remove hard-coded product margins and unsupported AI findings from `AIAgent.tsx`
- [x] Remove artificial retrieval behavior from the operational AI surface
- [x] Fail closed when no source-backed read controller exists; no live claims in P0
- [x] Revoke legacy write-capable AI RPCs and enforce server-side manager authorization

### P0 complete-all production evidence

- Implementation PR: #17 (`fix/p0-complete-all`)
- Final reviewed head: `d1299cef771dd8ad5104f034b20269f89d93cd1f`
- Exact-head CI 224 (`34164371309`): `quality` and `windows-package` green
- Squash merge: `6ad10038f5f12471a0ca252c52df3b0dafc1c669`
- Post-merge `main` CI 225 (`34164733691`): `quality` and `windows-package` green
- Post-merge Windows validation artifact: ID `10033852748`, SHA-256 `a015281fea2838882022bd3093e6e741344901487e71c653224145dda265d8be`
- External admin blocker: the connected GitHub App cannot configure the required `main` ruleset
- External signing blocker: production release requires `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`
- Physical acceptance boundary: printer, drawer, and installed updater behavior require deployed hardware; simulated transaction invariants are green

## P1/P2/P3

All downstream catalogue, inventory lot, stocktake, supplier/customer ledger, reporting, AI action, alert, price-intelligence, OCR, WhatsApp and optional LAN-resilience capabilities remain unchecked until their complete definition-of-done evidence exists.
