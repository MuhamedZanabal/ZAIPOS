# ZAIPOS Production Programme

This file is an evidence-based burn-down. An item is checked only when the corresponding implementation has been merged to `main` and verified there. Branch-only work remains unchecked until post-merge verification succeeds.

## P0 Transaction Core

- [x] Transaction invariant helpers/tests foundation
- [x] Exact BHD fils money Stage A sidecars/parity
- [x] Exact BHD three-decimal compatibility precision Stage B
- [x] Atomic server-authoritative checkout v2
- [x] Native split/mixed payments cashier UI
- [x] Checkout idempotency/offline replay full failure matrix
- [x] Void transaction lifecycle
- [x] Return/refund transaction lifecycle
- [x] Cash-session invariant lifecycle coverage
- [x] Client-facing inventory exactly-once command lifecycle
- [x] Server-authoritative physical inventory reconciliation
- [x] Table dispatch/undispatch row-lock protection before stock effects
- [ ] True simultaneous multi-connection checkout/stock-contention stress gate
- [ ] Wider tenant/branch relational consistency constraints
- [ ] Full sensitive-operation authorization matrix
- [ ] Full audit-integrity coverage
- [ ] POS end-to-end scan → pay → receipt → stock test
- [ ] Full clean-install + supported-upgrade migration-chain verification

## P0 Release

- [ ] Signed Windows installer
- [ ] Versioned GitHub Release workflow
- [ ] Electron publish/updater provider
- [ ] Update notification/download/install flow
- [ ] Stable/beta staged channels
- [ ] Rollback/known-good installer procedure
- [ ] Device version/last-seen reporting

## P0 AI Safety

- [ ] Re-audit current ZAIPOS AI prototype
- [ ] Remove hard-coded/fake operational metrics
- [ ] Source-backed read-only AI controller
- [ ] Server-side role-aware tool policy
- [ ] Evidence metadata for AI facts

## P1 Operational Capability

- [ ] Held/suspended carts
- [ ] Price override + manager approval
- [ ] POS PIN authentication
- [ ] Multiple barcodes + collision handling
- [ ] Product price history
- [ ] Cost history / historical COGS
- [ ] Bahrain pricing policy engine
- [ ] Duplicate product review/merge
- [ ] Inventory lots/batches/expiry
- [ ] Stocktake/cycle count
- [ ] Monetary inventory valuation
- [ ] Supplier subledger
- [ ] Supplier-product catalogue
- [ ] Customer profile/purchase history
- [ ] Bahrain customer addresses
- [ ] Loyalty ledger/rules
- [ ] Customer credit subledger
- [ ] Deterministic reporting foundation
- [ ] Staged import engine
- [ ] Backup/restore verification

## Evidence ledger

### Exact-money Stage B

- Merge SHA: `494a1e4d951dfa0ee5ce96ce9f847bc1038448bf`
- Migration: `20260905024000_exact_money_stage_b_precision.sql`
- Final branch CI: run 85
- Post-merge `main` CI: run 86

### Atomic checkout v2

- PR: #6
- Merge SHA: `b910502e1d625861cc8d4667148642c85a5a39e7`
- Primary migration: `20260905032000_atomic_checkout_v2.sql`
- Installed-client adapter: `20260905033000_checkout_sale_v2_compat.sql`
- Branch-RLS hardening: `20260905034000_checkout_operations_branch_rls.sql`
- Final branch CI: run 102
- Post-merge `main` CI: run 103
- Verified gates: localization, exact-money database contract, atomic checkout + installed-client adapter contract, branch-scoped checkout-operation RLS, lint, full Vitest suite, production build

### Split and mixed payments

- PR: #8
- Merge SHA: `fe512eca9b3e62597761696fdbbbbb6777e35373`
- Final branch CI: run 116
- Post-merge `main` CI: run 117
- Tests at merge: 13 Vitest files, 71 tests
- Verified gates: Cash/Card/BenefitPay/Bank Transfer allocation rules, cash over-tender/change, live POS v2 wiring, split receipt, cash-drawer intent, shared table-checkout compatibility, exact payment rows, isolated till buckets, replay stability, localization, migration validation, RLS, lint and production build

### Offline checkout replay / idempotency

- Implementation PR: #10
- Implementation merge SHA: `98ba7a07495be218128b351879ea864002b26453`
- Final reviewed branch head: `6dd95e537c0acfe2cec201970d8937621d8f3766`
- RED CI: run 121
- Final branch CI: run 123
- Post-merge `main` CI: run 124
- Evidence PR: #11
- Verified gates: explicit queued/sending/committed/retrying/failed/requires_review lifecycle, durable committed evidence, response-loss/crash replay, same-ID payload mismatch rejection, concurrent queue deduplication, transient retry ceiling, stale-state review routing, unknown-operation retention, tenant scope, sign-out durability, single-flight processing, operator retry/discard controls, stale stock/price/coupon/product/session/branch/customer database matrix
- Explicit scope boundary: true simultaneous multi-connection stock contention remained open after this slice

### Return / refund / void / cash lifecycle

- Implementation PR: #12
- Implementation merge SHA: `76ce641a847afa8fb94bad54b050fdcbde1aa682`
- Final reviewed branch head: `4cb0cd2a2419227edd9601aad0b58fc71a8dea7f`
- Final branch CI: run 162
- Post-merge `main` CI: run 163
- Evidence PR: #13
- Final evidence `main` CI: run 166
- Verified gates: exact integer-fils return/refund ceilings, split-payment compensation, stock/till exactly-once effects, branch-scoped evidence RLS, direct compensation-ledger mutation denial, exact void lifecycle, coupon reversal, immutable original sale/payment history, exact cash-session close reconciliation, customer-linked return fail-closed loyalty guard
- Intentional fail-closed boundaries: customer-linked compensation requires immutable exact loyalty-award reversal evidence; composite return/void requires historical component-consumption snapshots

### Inventory exactly-once / physical reconciliation

- Implementation PR: #15
- Final reviewed branch head: `131f97db04085ed18c31b44e086927480edfb4da`
- Merge SHA: `cb938bde406ebc7c36f7cea936d517a3dabb3c07`
- Primary migration: `20260905110000_inventory_exactly_once.sql`
- Physical reconciliation migration: `20260905110500_inventory_reconciliation_v2.sql`
- Server RED CI: run 170
- Initial server GREEN CI: run 172
- Client RED CI: run 174
- Missed Data Management surface exposed by build: run 181
- Expanded Data Management RED CI: run 182
- Physical-reconciliation RED CI: run 185
- First complete GREEN candidate: run 189
- Final reviewed-head CI: run 190
- Post-merge `main` CI: run 191
- Verified gates: transaction-level `inventory_operations` operation ledger, atomic manual/OCR/EAN batches, replay-safe transfer, atomic purchase-order receiving, row-locked production completion, table dispatch/undispatch row locking, low-level authenticated primitive revocation, client v2 cutover, server-authoritative physical target reconciliation, signed adjustment evidence for both increases and decreases, replay/mismatch protection, branch authorization, lint, full Vitest suite and production build
- Post-merge migration validation count: 55
