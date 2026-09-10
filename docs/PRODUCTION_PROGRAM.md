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
- [x] True simultaneous multi-connection checkout/stock-contention stress gate
- [x] Wider tenant/branch relational consistency constraints
- [x] Full sensitive-operation authorization matrix
- [x] Full audit-integrity coverage
- [x] POS end-to-end scan → pay → receipt → stock test
- [x] Full clean-install + supported-upgrade migration-chain verification

## P0 Release

- [ ] Signed Windows installer — external certificate credentials required
- [x] Versioned GitHub Release workflow
- [x] Electron publish/updater provider
- [x] Update notification/download/install flow
- [x] Stable/beta staged channels
- [x] Rollback/known-good installer procedure
- [x] Device version/last-seen reporting

## P0 AI Safety

- [x] Re-audit current ZAIPOS AI prototype
- [x] Remove hard-coded/fake operational metrics
- [ ] Source-backed read-only AI controller — scheduled for P2; P0 fails closed without live claims
- [x] Server-side role enforcement and legacy AI RPC lockdown
- [x] No operational AI fact emitted without source evidence in P0

## P1 Operational Capability

- [x] Historical receipt reprint fidelity + audit
- [x] Held/suspended carts
- [x] Price override + manager approval
- [x] POS PIN authentication
- [x] Multiple barcodes + collision handling
- [x] Product price history
- [x] Cost history / historical COGS
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

### P0 complete-all production gates

- PR: #17
- Final reviewed branch head: `d1299cef771dd8ad5104f034b20269f89d93cd1f`
- Final branch CI: run 224 (`34164371309`), `quality` and `windows-package` green
- Merge SHA: `6ad10038f5f12471a0ca252c52df3b0dafc1c669`
- Post-merge `main` CI: run 225 (`34164733691`), `quality` and `windows-package` green
- Post-merge Windows validation artifact: ID `10033852748`, SHA-256 `a015281fea2838882022bd3093e6e741344901487e71c653224145dda265d8be`
- Verified gates: 59-migration clean and supported Bahrain upgrade chains, exact historical fils preservation, tenant/branch structural integrity, true last-unit contention, concurrent same-operation replay, role/tenant/branch/roleless authorization, direct mutation lockdown, audit integrity, POS/hardware failure E2E, production dependency audit, Windows NSIS packaging, updater/release contracts, device registry, and P0 AI safety lockdown
- External controls: `main` protection requires repository-admin access; production Authenticode signing requires the documented certificate secrets; physical hardware/updater acceptance requires deployed equipment

### Historical receipt reprint and held carts

- PR: #19
- Final reviewed branch head: `e833fc2bec2bf4a3eba35697d0797b780b59596e`
- Final branch CI: run 235 (`34249166076`), `quality` and `windows-package` green
- Merge SHA: `8ff440db83d5dffd9afe8957501e9d252eebfcbf`
- Post-merge `main` CI: run 236 (`34249750458`), `quality` and `windows-package` green
- Post-merge Windows validation artifact: ID `10065669698`, SHA-256 `f2fae2f5b6bd29b8476aafe8a749339532430ed19c72aaf7578747d3c239e6eb`
- Migrations: `20260908021500_historical_receipt_reprint.sql`, `20260908030000_held_carts.sql`
- Verified gates: immutable historical sale/item/payment receipt snapshots, branch authorization, RLS, direct-write lockdown, idempotent reprint audit lifecycle, Bahrain BHD three-decimal Electron rendering, branch-scoped hold/list/resume/discard lifecycle, resume-time product/modifier/price/stock validation, explicit cashier conflict resolution, response-loss operation replay, loading/empty/error/retry UI states, 61-migration clean and supported Bahrain upgrade chains, 26 Vitest files / 125 tests, TypeScript, lint, production build and Windows packaging
- Operational boundary: physical receipt output still requires acceptance testing on each deployed printer model

### Price override and manager approval

- PR: #21
- Final reviewed branch head: `2f3fe7cbe9a95b5b0cb379b278812c7c782143ee`
- Final branch CI: run 243 (`34299047877`), `quality` and `windows-package` green
- Merge SHA: `6860918b2eb8ef9a8dafcc8141f1a5ad33578d10`
- Post-merge `main` CI: run 244 (`34299418189`), `quality` and `windows-package` green
- Post-merge Windows validation artifact: ID `10084459463`, SHA-256 `07addf252863984dfcbc01741940ecc586dbd104972156e9b08b6dd71d1d39b6`
- Migration: `20260909010000_price_override_approval.sql`
- Verified gates: explicit request/approve permissions, tenant/branch authorization, requester self-approval denial, exact-fils one-time checkout consumption, immutable sale-line approval history, exactly-once audit evidence, direct mutation and internal-permission-probe lockdown, cashier and manager UI, stale offline review routing, 62-migration chains, 27 Vitest files / 134 tests, TypeScript, lint, production build and Windows packaging

### POS PIN authentication

- PR: #22
- Final reviewed branch head: `3ed299356dddb64063b8c4d688e2f983bc42d7e6`
- Final branch CI: run 249 (`34348976347`), `quality` and `windows-package` green
- Merge SHA: `5ba2d19b360df76adc260f0d429d47b652301d78`
- Post-merge `main` CI: run 250 (`34349488299`), `quality` and `windows-package` green
- Post-merge Windows validation artifact: ID `10103245878`, SHA-256 `bb151c5180ed1704faf1633c5b8f186e6df25daf6d0786a9254c506318504c21`
- Migration: `20260909030000_secure_pos_pin.sql`
- Verified gates: Argon2id server-side hashing, no plaintext application PIN columns, service-only credential commands, manager and tenant/branch authorization, registered-device and open-session context, five-attempt lockout, credential-version invalidation of in-flight attempts, successful legacy conversion, immutable attempt/audit evidence, direct credential mutation lockdown, Edge JWT validation, 63-migration clean and supported Bahrain upgrade chains, TypeScript, lint, full Vitest suite, production build and Windows packaging

## Catalogue production evidence reconciled 2026-09-10

- Multiple barcodes and collisions: PR #23, merge `09acaf9e061d11fde681e2077b89d2443f776358`; final head `384f4d7da903ca9849289b9ab0abb4a3bf558e05`; PR CI 255 (`34384916594`), post-merge main CI 256 (`34385521325`), successful quality and Windows packaging.
- Product financial history: PR #24, reviewed head `614df4f9739a478b0e6312e6cad2b372541c3402`; merge `ffe82e2df0d0d71818f562c6e74d708aa50872e8`; PR CI 262 and post-merge main CI 263 (`34433517501`), successful quality and Windows packaging.
- Verified PR #24 scope: exact selling-price/cost ledgers, immutable post-migration sale COGS, supplier receipt provenance, effective intervals, authorized/idempotent RPCs, tenant/branch RLS, mutation lockdown, audit, clean and Bahrain upgrade preservation. Tenant-global financial mutations require a tenant-wide authorized role.
- Historical pre-migration COGS remains explicitly labelled as reconstructed from cost at migration; this is not original-sale cost provenance.
- Bahrain pricing policy remains OPEN in PR #25 until merge and post-merge verification.
