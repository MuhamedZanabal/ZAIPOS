# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current checkpoint — PR #83 (2026-09-23 10:27:00 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #83 branch `fix/atomic-table-order-items-20260923` is stacked directly on clean PR #82 head `1602ea9ea0ddf54d743400ec6fa18701317e5bb6`. Verified code head `02361a3f80bed4b4e1f5a60522b4b552096af463` is mergeable and clean with no submitted reviews or inline threads. No merge is authorized.
- Restaurant item add/quantity/delete now uses one SECURITY DEFINER command. Authenticated direct INSERT/UPDATE/DELETE and direct recalculation are revoked; the broad `toi_member_all` policy is removed. The command locks the open order, verifies active tenant/branch plus assigned waiter or elevated branch role, derives authoritative table-channel pricing, computes BHD totals through integer fils, journals the canonical request and audits the result atomically.
- Renderer code persists the operation identity before submission, reuses it after an indeterminate response, and no longer supplies price/tax/total fields. KDS status transitions remain server RPCs. Persisted legacy `ADD_TABLE_ORDER_ITEMS` records remain quarantined by the parent work; offline checkout remains disabled.
- Exact-head evidence: all 21 workflows succeeded. CI #725 / run `35831057784` passed quality job `107083502459` and unsigned Windows packaging job `107084293991`. Table Checkout Security run `35831057836` passed the real PostgreSQL direct-DML, wrong-branch, unassigned-waiter, detail, exact-fils, replay, payload-conflict, audit, deletion and two-session concurrency contract.
- CI found and repaired one real defect: code head `322671a` referenced nonexistent restaurant-item fils shadow columns. Head `02361a3` instead converts authoritative numeric columns through `bhd_numeric_to_fils` before all aggregation and proves a `0.001` quantity produces an exact `0.002` BHD subtotal rather than sub-fils state. Do not cite `322671a` as passing evidence.
- Local verification: 64 Vitest files / 342 tests, TypeScript, production build (2,771 modules), 122 migration validations, renderer cutover and native vault contracts, `git diff --check`, and ESLint zero errors / 13 pre-existing warnings passed. Local `psql` is unavailable; exact-head CI supplied disposable real-PostgreSQL evidence. No force push, merge, deployment, release or production-data operation occurred.

### Immediate next executable actions

1. Add real PostgreSQL authorization contracts for `start_preparing_table_item`, `mark_table_item_ready`, `send_table_order_to_kitchen`, `mark_table_order_ready`, `dispatch_table_item` and `undispatch_table_item`; replace tenant-membership-only checks with explicit tenant/branch/role/order authority and stable mutation identity where financial inventory effects occur.
2. Continue the remaining financial-operation census and evidence matrix, then complete offline restart, contention, corruption, quarantine and operator-recovery acceptance while checkout stays disabled.
3. Review and integrate the draft security stack only through normal review; preserve signing, physical hardware, measured production DR, provider authorization and regulatory acceptance as external gates.

## Previous checkpoint — PR #82 (2026-09-23 09:16:39 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main is still `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #82 now targets current PR #81 head `5b3e267013adb05bdfa917c3c55a0ac3a006e923` at exact head `c7de8849817b878ad72ea3af4fe0afab9362bf5c`. GitHub reports the PR mergeable and clean; there are no submitted reviews or inline threads. No PR merge is authorized.
- The non-force two-parent synchronization commit incorporated PR #81's verified queue scope/inventory quarantine work and retained all device-bound cash-session changes. It also removes the non-atomic `ADD_TABLE_ORDER_ITEMS` replay path: new enqueue attempts fail closed and persisted records become `requires_review` without an RPC, direct table insert, payload mutation or deletion.
- Exact-head evidence: all 21 workflows succeeded. CI #722 / run `35825484644` passed quality job `107066155815` (real PostgreSQL migration/authorization/concurrency chain, inventory cutover contract, 339 Vitest tests, lint and build) and unsigned Windows packaging job `107066845401`. Trusted Device Enforcement `35825484362`, Table Checkout Security `35825484482`, and Backup Restore `35825484358` also passed at this exact SHA.
- Local source-equivalent verification: TDD reproduced three failures before the legacy table-item quarantine; focused 3 files / 43 tests passed afterward; full 63 files / 339 tests, TypeScript, ESLint zero errors / 13 pre-existing warnings, production build (2,770 modules), 121 migration validations, inventory client cutover, native vault and `git diff --check` passed. Local real PostgreSQL remains unavailable because `psql` is not installed; exact-head CI supplied disposable PostgreSQL evidence.
- Offline checkout remains disabled. No merge, force push, deployment, release, production-data mutation, credential exposure or control weakening occurred.

### Immediate next executable actions

1. Audit and replace the remaining direct `table_order_items` insert/update/delete renderer paths and the broad `toi_member_all` policy with atomic server commands, explicit branch/role authority, stable operation identity and PostgreSQL zero-effect/replay tests.
2. Continue device-bound classification of `record_inventory_batch_v2`, reconciliation, transfer, purchase receiving and production completion without re-exposing the retired raw stock primitive.
3. Finish offline restart, contention, corruption, quarantine and operator-recovery acceptance while the checkout gate remains disabled; then review the entire stacked security chain.
4. Preserve signed Windows, physical hardware, measured production DR, provider authorization and regulatory acceptance as external gates.

## Previous checkpoint — PR #82 (2026-09-23 03:39:30 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #82 branch `fix/device-bound-cash-sessions-20260923` is stacked on draft PR #81. PR #81 advanced to `5b3e267013adb05bdfa917c3c55a0ac3a006e923`; this child branch is being synchronized by a normal two-parent commit without rewriting history. No PR merge is authorized.
- Verified code head: `c39b2fd202e952bc36aa49974d52c5a33e949910`. All 21 exact-head workflows completed successfully. CI #711 run `35802372217` passed quality job `106995380229` and unsigned Windows packaging job `106996048355`. Trusted Device Enforcement run `35802372280` passed the device-bound cash-session contract on real PostgreSQL. Unsigned packaging is not signing, installation, upgrade or rollback acceptance.
- Credential-less `open_cash_session` and `close_cash_session` execution is revoked from authenticated callers. Device-bound v2 wrappers validate tenant, branch, user, enrolled/non-revoked terminal credential and exact BHD three-decimal inputs before opening or final reconciliation.
- The renderer persists an immutable operation ID and canonical request before native submission, retains it across a lost response/restart and refuses a different operation while recovery is pending. Credential plaintext remains Electron-main-only behind narrow IPC.
- PostgreSQL coverage proves missing/copied/wrong-branch/revoked credentials, payload substitution, legacy RPC calls, fractional fils, NaN/infinity, inactive branches and banned accounts are denied; rejected calls have zero operation/session effects. Opening/closing replay returns the original session. Existing concurrent cash movement/close and multi-open races now execute through enrolled-device authority.
- CI-discovered repairs: initial head `a808121` lacked the required composite tenant/branch foreign key; `32e546f` added it. That head exposed the legacy close call in the cash-mutation race; `09c51e8` migrated it. That head then exposed credential-less open/close in the cash-session boundary suite; `c39b2fd` migrated the full exact-fils, account, branch, audit-rollback and contention contract. Do not cite the failed heads as passing evidence.
- Local source-equivalent verification: focused 3 files / 22 tests; full 63 files / 329 tests; TypeScript; ESLint zero errors / 13 pre-existing warnings; production build (2,770 modules); 121 migration validations; native vault/static contracts; PostgreSQL script syntax and `git diff --check` all passed. No merge, deployment, release, force push or production-data operation occurred. Offline checkout remains disabled.

### Immediate next executable actions

1. Re-fetch PR #82, distinguish its documentation head from verified code head `c39b2fd`, and inspect all exact-head workflows before trusting this checkpoint.
2. Continue the mutation census with renderer-callable inventory authority (`apply_inventory_movement` and adjacent inventory RPCs): classify the boundary, reproduce any credential-less unauthorized path, and add positive/negative PostgreSQL proof before a scoped cutover.
3. Complete offline restart, contention, corruption, quarantine and operator-recovery acceptance while keeping the immutable offline checkout gate disabled; then review the complete stacked security PR chain.
4. Preserve external signing, physical hardware, production DR, provider authorization and regulatory gates as unresolved until independently exercised.

## Previous checkpoint — PR #81 (2026-09-23; later code head verified)

- Repository `MuhamedZanabal/ZAIPOS`; at the last confirmed main check `44dd533251acde0de35fe31a8286532857d268ef` (recheck). Open, unmerged, **draft** PR #81 branch `fix/device-bound-table-checkout-20260922` targets draft PR #80 branch `fix/device-bound-delivery-collection-20260922`, base commit `ba236f9ef4d05357bcacad968ea023feadd319b9`. No merge or deployment authorized.
- **Verified code head** `1afa7805c7241771e8e966ac4a0daed13fd47a72`: all **21 exact-head workflows succeeded**. CI #720 / run `35810781398` passed quality `107021638399` (production PostgreSQL migration, concurrency/adversarial suite, lint, Vitest, build) and unsigned Windows packaging `107023141783`. The Table Checkout Security `35810781441`, Trusted Device Enforcement `35810781400`, and Backup Restore Contract `35810781343` independently succeeded on the exact code head. Do not equate unsigned packaging with signed installation/hardware acceptance.
- Code head `1afa7805` is **nine commits after** previous docs-only checkpoint `4a9ed4533f1eef9691b77b3eb813a196dfdf1a34`. Documentation commits after `1afa7805` must not be cited as the verified code head unless their separate workflows complete.

### Table settlement already implemented and verified at repository-test level

- Main-process Electron credential custody through narrow IPC; both cashier pending-order and table-detail checkout paths fail closed without an authenticated, provisioned desktop device. Renderer queue prevents new `CHECKOUT_TABLE_ORDER` entries and quarantines old records, preserving reconciliation evidence.
- `checkout_table_order_v2_device` enforces tenant/branch, enrolled and non-revoked device, eligible settlement role, exact BHD three-decimal input and stable per-order idempotent retry before delegating to atomic checkout. Waiter settlement denied. The prior six-argument credential-less RPC has EXECUTE revoked for PUBLIC/anon/authenticated and retired two-argument overload is asserted absent. PostgreSQL tests check same-ID/different-ID concurrency, lost response, changed payload, cross-branch/revoked/missing device and zero extra financial effects.
- Initial PR #81 migrations failed at `7e7d01f` because the production chain had already dropped a legacy overload; `c9a66ef` fixed effective signatures. Another failure identified waiter denial in the authoritative stock function; `782a886` aligned public settlement classification and added negative waiter proof. Cite only later green heads.

### Follow-on correction in this checkpoint — offline sync and authorization

1. Confirmed `src/hooks/useSyncEngine.ts` had attempted direct `APPLY_INVENTORY_MOVEMENT` replay while production migration `20260905110000_inventory_exactly_once.sql` revokes authenticated execution. New enqueue and direct online hooks now reject this retired raw stock primitive; persisted queue records move to `requires_review` without network calls, deletion, or silent conversion to elevated inventory authority. Corrected previous mocked tests which falsely treated this RPC as permitted. Supported inventory APIs remain distinct.
2. Generated SQL types show `send_table_order_to_kitchen`, `mark_table_order_ready`, and `send_table_order_to_cashier` each accept only `{ _order_id }`. Replay now projects the exact SQL arguments, excluding local `_client_mutation_id` metadata; original queued payload and recovery identity remain unchanged.
3. For allowed offline operations, queue insertion now requires a selected active tenant and branch, rejects a conflicting declared payload scope, and persists selected tenant/branch for order-only SQL payloads. Reuse of a mutation ID in another branch is rejected; queue processing filters active branch as well as tenant. Regression tests cover zero-scope, contradictory scope, cross-branch, successful same-scope replay and legacy quarantine.
4. The exact-head CI run above passed the updated test suite and all 21 workflows. No signed build, physical-device validation, installation or production DR exercise occurred.

### Immediate next executable actions

1. Re-fetch PR #81 and verify latest head and exact-head checks. Maintain distinction between proven code `1afa7805` and any subsequent documentation commit.
2. Complete financial-RPC and authorization census. Highest-priority remaining source path: `ADD_TABLE_ORDER_ITEMS` in `src/hooks/useSyncEngine.ts` directly inserts `table_order_items` then separately calls `recalc_table_order`. Check live callers, PostgreSQL schema/unique constraints/RLS, operation identity and replay semantics. Without real at-most-once evidence, quarantine legacy queue records rather than send speculative duplicate line items; do not silently translate privileged writes.
3. Examine operator reconciliation / manual retry for cutover records; do not allow misleading retries that simply bounce quarantined records to `requires_review`. Complete full offline crash, contention, corruption, reconciliation and recovery acceptance before enabling ANY offline financial checkout; existing hard-disabled native orchestrator must remain disabled.
4. Review full stacked PR security integration without unapproved merge, then separately P1 Windows signing/install/upgrade/rollback, physical scanner/printer/drawer, authoritative retail/restaurant separation and accessibility/operator workflows.

## Previous checkpoint — PR #80 delivery collection (2026-09-22)

- Active stack at prior audit #80 → #79 → #78 → #77 → #76 → #75 → #74 → #72. PR #80 code head `04f167ec70f6ad06e174f8058a88e58b9b54437e`, documentation head `ba236f9ef4d05357bcacad968ea023feadd319b9`, base #79 `e47ea2aba84bf867b01df999fa9d496897e35b77`.
- Prior PR #80 code-head CI 20/20 successful; CI #693 `35762405187` passed PostgreSQL tests, quality and unsigned Windows packaging. Delivery Financial Authority and trusted device contracts passed. This is not signing, installation, hardware or DR acceptance.
- Delivery collection `collect_delivery_payment_v3_device` checks native enrolled credentials and tenant/branch; a private verifier admits assigned courier without broadening general financial roles. Original atomic collection validates assignment. Credential-less v2 authenticated grant revoked. Tests cover exact fils, replay, concurrency, revocation and negative roles.

## Persistent release gates

- Offline checkout is hard-disabled; never enable without independent, complete crash, contention, corruption, reconciliation and recovery acceptance. No renderer/preload credential exposure or uncontrolled financial queue.
- Complete financial authorization matrix, inventory/order mutation replay audit, security-stack review and authorized integration. No unapproved PR merge.
- P1 authoritative RETAIL/RESTAURANT enforcement, signed Windows install/upgrade/rollback, real peripheral tests, measured production RPO/RTO, accessibility and operator workflows.
- P2 authorized payment/messaging integrations, Bahrain VAT verification, accounting exports and governed AI. P3 command center, kiosk, kitchen optimization, franchise and extension support.
- External signing credentials, physical hardware, real production recovery exercise, provider authorization and regulatory acceptance remain unresolved. ZAIPOS is **not production ready**.
