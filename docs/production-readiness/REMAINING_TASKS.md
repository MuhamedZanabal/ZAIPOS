# Remaining production tasks

Classification: **PARTIALLY COMPLETE**. Repository baseline: main `77e64793e473c769af988dcce15e91483c5fdbfa` (PR61); all 18 post-merge workflows passed, including CI/Windows 34908061038 and backup/restore 34908060965. PR62 is the active cash movement replay change. Version 1.0.0 does not itself establish an accepted release.

This is the complete currently identified execution queue, including unfinished audits. Audit rows are obligations to inspect and prove scope, not assertions that every named feature is broken or absent. A final exhaustive defect list cannot truthfully precede those audits. Update this file and PRODUCTION_LEDGER.json as evidence changes. Do not redo named green contracts without a relevant change or contrary evidence.

## Confirmed implementation and integration work

| ID | Priority | Remaining task / completion evidence |
|---|---|---|
| CASH-002A | P0 | Finish PR62 exact-head PostgreSQL/UI/security/concurrency/regression/Windows verification, merge and verify post-merge main. Prove manual cash movement retry, cancellation and restart recovery. |
| CASH-002B | P0 | Add payload-bound operation identity and restart recovery for opening and closing cash sessions; reject sub-fils or omitted blind counts; verify duplicate/concurrent/lost-response/closed-session behavior. |
| SEC-004 | P0 audit frontier | Establish actual enrolled-device and revocation enforcement for checkout/native/offline paths. Device UUID/heartbeat currently does not itself prove trusted enrollment. Reproduce any bypass before implementing controls; document offline revocation limits. |
| CASH-003 | P1 | Integrate customer-credit cash repayments and supplier cash settlements with explicit receiving/paying tills atomically; prove ledger plus till plus audit replay and rollback. |
| UI-001 | P1 | Complete customer credit limits, repayment, balance, statement/history and address workflows against authoritative RPCs; preserve exact fils and authorization. |
| UI-002 | P1 | Complete supplier ledger payment/credit/statement/ageing and reconciliation workflows; review PO/receipt/return integration and historical liabilities. |
| UI-003 | P1 | Complete missing inventory stocktake, cycle count, lot/expiry, valuation and exception workflows after route-to-RPC tracing; preserve one stock authority. |
| DEL-002 | P1 | Define and implement delivery fee VAT and immutable fee history; connect fee refunds/reporting, legacy collection reconciliation and courier cash custody/remittance. |
| EXP-001 | P1 | Add authorized exact statement/history exports where needed; handle larger snapshots by controlled streaming/pagination without silent truncation. Catalogue/stock selected-field snapshots are merged in PR60. |
| REL-001 | P1 | Complete release candidate/version/changelog/tag/artifact/checksum evidence, actual signing checks, updater and rollback/migration compatibility; produce the strongest valid candidate available. |

## Remaining domain audits and required acceptance evidence

| ID | Priority | Task |
|---|---|---|
| AUD-DB | P1 | Reconcile fresh and realistic upgrade migration coverage, drift, ownership/grants/RLS, hardened definers, FK integrity and recovery procedure. Extend tests only for uncovered paths. |
| AUD-TXN | P0/P1 | Trace checkout, split payment, discounts/overrides, returns/refunds/voids and held carts through before-call, commit/response-loss, crash/retry and adversarial concurrency boundaries. |
| AUD-OFFLINE | P0/P1 | Prove queue persistence/restart, ordering, replay, partial sync, stale prices/stock, corruption and reconnection; simulate power loss where feasible and isolate physical acceptance. |
| AUD-MULTI | P0/P1 | Reconcile actual Electron/Dexie/Supabase multi-terminal architecture, default versus named register selection, terminal identity and CAP/double-sell boundaries. Do not invent a LAN hub requirement. |
| AUD-INVENTORY | P1 | Trace receiving, adjustments, transfers, negative-stock policy, lots/FEFO/expiry, damage/waste/shrinkage, stocktake, valuation/reconciliation and stock alerts end to end. |
| AUD-SUPPLIER | P1 | Verify partial/full/over receipt, PO cancellation, supplier invoice references, credit notes/returns, payment allocation, ageing, branch scope and immutable cost provenance. |
| AUD-CUSTOMER | P1 | Verify contact/address/archive/privacy, phone/duplicate handling, sale/return/delivery history, loyalty reversal, credit limits and overpayment rejection. |
| AUD-CATALOGUE | P1 | Verify barcode collisions/merges/source aliases, units/packaging, status/archive, exact costs/history, channel/branch prices and realistic search/import/export scale. |
| AUD-REPORTS | P1 | Map each displayed sales/payment/VAT/discount/COGS/margin/inventory/supplier/customer/till/channel figure to exact persisted evidence and drill-down; remove fabricated or unsupported values. |
| AUD-OWNER-AI | P1/P2 | Verify existing Owner Intelligence/ZanAI findings are read-only and trace to scope, time window, source IDs, calculation, confidence and BHD impact. Add only justified evidence-backed findings after reporting authority. |
| AUD-CHANNELS | P1 | Verify physical POS/tables/Talabat/WhatsApp/delivery retained workflows and payment reconciliation; remove misleading dead UI where no backend exists. External provider automation is credential-dependent. |
| AUD-RECEIPT | P1 | Verify historical receipt/reprint content, payment/refund breakdown, identity/reference, printer errors/retry/duplicate-print behavior; run physical acceptance separately. |
| AUD-TILL | P0/P1 | Trace every cash-affecting sale/refund/delivery/repayment/withdrawal/correction path; prove immutable session reconstruction, counts, discrepancies, manager boundaries and forced/crash close. |
| AUD-AUTH | P0/P1 | Complete privileged-action matrix for every role, tenant/branch, inactive/deleted/banned account, direct write, replay/payload substitution, stale role and missing session. |
| AUD-DEVICE | P0/P1 | Review PIN/session/idle lock, local secrets/data, debug surfaces, IPC exposure, CSP/navigation, settings/updater trust and revocation. Existing desktop/native hardening does not certify enrollment. |
| AUD-DR | P1 | Extend beyond passing backup/restore contracts for remaining permission/tool/disk/operator/interruption cases; reconcile responsibilities and managed Auth/Storage/offline queue boundaries. |
| AUD-OBS | P1 | Verify useful non-secret structured diagnostics and correlation/operation IDs across client, DB, sync, native devices, updater and backup failures. |
| AUD-PERF | P1 | Measure representative barcode/search/checkout/report/stock/import/duplicate detection/customer/supplier statement workloads at realistic scale; fix demonstrated bottlenecks, document measured limits. |
| AUD-WINDOWS | P1 | Verify installer/update/downgrade/restart/crash/user-data preservation/channel trust and cleanup; distinguish unsigned CI packaging from signed and physical acceptance. |
| AUD-SECURITY | P0/P1 | Finish adversarial SQL/XSS/path/IPC/RLS/definer/supply-chain/secrets/session/tampering review; reproduce and close repository-fixable critical/high findings. |
| AUD-UX | P1 | Complete cashier keyboard/touch/barcode/loading/error/offline/retry/approval/accessibility/empty-state/long-name/three-decimal and supported-language acceptance. |
| AUD-IMPORT | P1 | Finish malformed/duplicate/oversized/negative/Unicode/category/supplier/repeated-operation/payload-mutation import checks; preserve atomicity and formula-safe export boundaries. |
| AUD-HISTORY | P0/P1 | Add or reconcile consistency checks for sales/lines/payments/refunds, inventory/movements, supplier and credit/loyalty balances; investigate discrepancies without rewriting history. |
| AUD-HYGIENE | P1 | Reconcile all active PRs/branches and prove unique work before closing/deleting obsolete branches; keep README/architecture/operator/release/DR docs and ledger current. |
| AUD-FINAL | P1 | Re-audit the full declared production scope after merges; require zero executable P0/P1 items, exact-head/post-merge gates, evidence package and deployment/rollback/smoke checklists before readiness classification. |

## External acceptance and dependencies

| ID | Status | Required action |
|---|---|---|
| EXT-SIGN | BLOCKED — EXTERNAL | Supply trusted production Authenticode credentials; build and verify a genuinely signed installer/update, not a simulated signature. |
| EXT-HW | BLOCKED — EXTERNAL | Execute actual Windows install/upgrade/reboot/sleep and scanner/printer/drawer/touch/USB/LAN/multi-terminal/network-outage acceptance on store equipment. |
| EXT-PROTECT | BLOCKED — EXTERNAL | Repository administrator configures branch protection and required status checks; merge authorization does not confer administration access. |
| EXT-PROD-DR | BLOCKED — EXTERNAL | Use production Supabase/Auth/Storage credentials and approved offsite encrypted storage; rehearse a real operational recovery and measure RPO/RTO. CI round trips do not certify production recovery times. |
| EXT-PROVIDERS | BLOCKED — EXTERNAL where retained | Provide relevant WhatsApp/Talabat/payment-provider credentials and perform live integration/reconciliation acceptance; manual payment recording does not verify provider settlement. |

Optional P2/P3 expansion (advanced forecasting, additional integrations, automation, broader intelligence and optimization beyond measured needs) must be explicitly scoped/deferred after essential production operation is complete. It cannot hide unresolved P0/P1 work.
