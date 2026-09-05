# ZAIPOS Production Programme

This file is an evidence-based burn-down. An item is checked only when the corresponding implementation has been merged to `main` and verified there. Branch-only work remains unchecked until post-merge verification succeeds.

## P0 Transaction Core

- [x] Transaction invariant helpers/tests foundation
- [x] Exact BHD fils money Stage A sidecars/parity
- [x] Exact BHD three-decimal compatibility precision Stage B
- [ ] Atomic server-authoritative checkout v2 — PR #6 branch verification in progress
- [ ] Native split/mixed payments cashier UI
- [ ] Checkout idempotency/offline replay full failure matrix
- [ ] Concurrent checkout/stock-conflict tests
- [ ] Void transaction lifecycle
- [ ] Return/refund transaction lifecycle
- [ ] Cash-session invariant lifecycle coverage
- [ ] Full sensitive-operation authorization matrix
- [ ] Full audit-integrity coverage
- [ ] POS end-to-end scan → pay → receipt → stock test

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

Branch evidence is tracked in PR #6 and must not be promoted to a completed checkbox until the PR is merged and the resulting `main` SHA passes post-merge CI.
