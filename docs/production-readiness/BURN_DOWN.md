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

The downstream programme is reconciled through the implemented P2 control-plane and operational-alert slices. Items below are marked complete only where implementation has merged and the production migration/regression matrix preserves the capability. Still-unimplemented future capabilities remain explicitly unchecked.

## P1 POS operations

- [x] Historical receipt reprint — PR #19
- [x] Held carts with authoritative resume validation — PR #19
- [x] Controlled price override + manager approval — PR #21
- [x] Secure employee POS PIN authentication — PR #22

## P1 catalogue

- [x] Multiple barcodes + collision handling — PR #23
- [x] Product price history — PR #24
- [x] Cost history / historical COGS — PR #24
- [x] Bahrain cost-plus pricing policy engine with explicit manager application — PR #25
- [x] Duplicate product review/merge — PR #26
- [x] Atomic, payload-bound catalogue import — PR #27

## P1 inventory

- [x] Inventory lots, batches, expiry controls and FEFO allocation — PR #28
- [x] Authoritative stocktake / cycle count lifecycle — PR #30
- [x] Exact monetary current-cost inventory valuation — PR #31

## P1 suppliers

- [x] Immutable exact-fils supplier payable/payment subledger — PR #32
- [x] Authoritative supplier-product catalogue — PR #33

## P1 customers

- [x] Immutable loyalty ledger with exact return/void reversals — PR #34
- [x] Authoritative customer profiles and Bahrain delivery addresses — PR #35
- [x] Exact-fils customer credit subledger — PR #36

## P1 reporting, resilience, cash and delivery authority

- [x] Deterministic, server-authoritative branch reporting foundation — PR #37
- [x] Verified PostgreSQL backup/restore rehearsal with integrity evidence — PR #38
- [x] Delivery monetary authority converted to exact fils and server-authoritative registration — PR #40
- [x] Delivery financial-authority runtime hardening — PR #41
- [x] Authoritative cash/till intelligence from immutable exact-fils close snapshots — PR #44

## P2 AI control plane

- [x] Source-backed read-only AI reporting controller — PR #39
- [x] Human-reviewed AI action request queue with no autonomous execution path — PR #42
- [x] User-facing branch-scoped AI action request/review surface with no execution path — PR #45
- [x] Source-backed proactive stock/expiry alert foundation and read-only operator surface — PR #46
- [x] Deterministic alert v1 with caller-bounded expiry/cash windows, Bahrain date handling and exact-fils cash variance — PR #48
- [x] Operator UI cutover to alert v1 with 30-day expiry and 7-day cash lookback, including exact-fils cash variance display — PR #51

## Later / explicitly unresolved capabilities

- [ ] Competitor / external price intelligence with authoritative provenance
- [ ] Production OCR ingestion beyond existing inventory mutation safety boundaries
- [ ] WhatsApp operational channel integration
- [ ] Optional LAN-resilience expansion, only if a measured decision gate requires it

## Production evidence reconciliation — 2026-09-12

- Current verified `main`: `f54d2e73c1a4676dd740b7e7cd4d81863fdd545e` (PR #51 squash merge).
- PR #44 merged authoritative manager-scoped cash/till intelligence from immutable exact-fils close snapshots.
- PR #45 merged the branch-scoped human review UI while preserving the approval-only/no-execution boundary.
- PR #46 exact tested head `4bf183b6e751fb0057a7aaa29b4dbfcf3deb1173`; Operational Alerts Contract, full CI quality and Windows validation packaging were green before merge. Merge: `e34c88acab90b874bbf6aa636975013348222d2d`.
- PR #48 exact tested head `aa408315205e03e2da7337a324bf967e31ac601e`; merge `b1e55d00fbef0358c6672a18af1e4372aeb9b8ff`. Post-merge CI run `34717926014` passed full quality and Windows validation packaging; no failed, queued or in-progress runs remained when verified.
- PR #51 RED head `e3012b4ee7111ae0e2082a8526ff1dddffd55057` failed at the proactive-alert UI contract before implementation. Implementation head `34943c635512bbe3c173faa3b305317a16712507` passed Operational Alerts Contract, AI Read Controller Contract, AI Action Approval Contract, full CI run `34718514806` quality and Windows validation packaging.
- PR #51 merge: `f54d2e73c1a4676dd740b7e7cd4d81863fdd545e`. Post-merge CI run `34718777647` passed full quality and Windows validation packaging; no failed, queued or in-progress runs remained when reconciled.
- Superseded draft PRs #47 and #50 were closed rather than merging overlapping alert authorities.
- The current `main` branch is not protected; repository-admin permission remains required to enforce the documented required checks.
- Production Authenticode signing remains blocked on external certificate credentials `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.
- Physical printer, cash-drawer and installed-updater acceptance remains a deployed-hardware boundary.

## Catalogue production evidence reconciled 2026-09-10

- Multiple barcodes and collisions: PR #23, merge `09acaf9e061d11fde681e2077b89d2443f776358`; final head `384f4d7da903ca9849289b9ab0abb4a3bf558e05`; PR CI 255 (`34384916594`), post-merge main CI 256 (`34385521325`), successful quality and Windows packaging.
- Product financial history: PR #24, reviewed head `614df4f9739a478b0e6312e6cad2b372541c3402`; merge `ffe82e2df0d0d71818f562c6e74d708aa50872e8`; PR CI 262 and post-merge main CI 263 (`34433517501`), successful quality and Windows packaging.
- Verified PR #24 scope: exact selling-price/cost ledgers, immutable post-migration sale COGS, supplier receipt provenance, effective intervals, authorized/idempotent RPCs, tenant/branch RLS, mutation lockdown, audit, clean and Bahrain upgrade preservation. Tenant-global financial mutations require a tenant-wide authorized role.
- Historical pre-migration COGS remains explicitly labelled as reconstructed from cost at migration; this is not original-sale cost provenance.