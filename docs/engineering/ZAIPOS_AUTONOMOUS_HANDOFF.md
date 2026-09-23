# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current checkpoint — draft PR #88 device-bound inventory commands (2026-09-24 01:20 +03)

- Draft PR #88 is stacked on PR #87. Exact code head `3ddf09b3919af0bc7d71d675ce493bb06da296d9`; base `7c2a1ba07faeb2ae0616a08505d7c1c13f7f55af`. No merge, deployment or release is authorized. Offline checkout remains disabled.
- Authenticated execution was revoked from inventory batch, physical reconciliation, transfer, purchase receiving and production-completion v2 routines. Five v3 wrappers require an active tenant/branch-matched enrolled device and retain the v2 atomic/idempotent cores and role checks.
- All renderer call sites now fail closed outside the trusted desktop and use one allowlisted IPC boundary. The credential remains OS-encrypted and is injected only in Electron main.
- CI exposed three stale contracts that called revoked APIs. They were migrated to enrolled-device calls without restoring grants. Current exact-head quality job `107405745008` passed its full real-PostgreSQL chain. Twenty independent workflows completed successfully; unsigned Windows packaging was still running when this checkpoint was written.
- Local: 68 Vitest files / 364 tests, TypeScript, build (2,773 modules), 129 migrations, inventory client cutover, ESLint zero errors (13 pre-existing warnings), and `git diff --check` passed.
- Remaining: independently add dedicated missing/copied/wrong-branch/revoked credential and zero-effect tests for each inventory wrapper; rebuild the authorization census; packaged recovery/operator acceptance; authoritative RETAIL/RESTAURANT enforcement; external signed Windows/hardware/DR/provider/regulatory acceptance.

### Immediate next executable action

Wait for PR #88 exact-head packaging completion, then add the dedicated inventory device-bound PostgreSQL matrix. Review PRs #86, #87 and #88 normally; do not merge autonomously.

## Current checkpoint — draft PR #87 authoritative table cart (2026-09-23 22:17 +03)

- Main remains `31c81f69bac26690cb12bc897759db056dbc6642`. Draft PR #87 exact code head `48e9286e396464c2b03a3246f8c1fa3a73c486f2` extends the verified legacy-RPC revocation with an authoritative cart replacement. No merge is authorized and offline checkout remains disabled.
- `append_table_cart_v2` accepts only product IDs, quantities, modifier option IDs and notes. It calls the scoped order-opening command, locks the order, revalidates branch/role/waiter authority, derives product identity, table-channel price, tax, modifier names/deltas and exact-fils totals, enforces required/min/max modifier rules, and audits the single transaction.
- Renderer-supplied product names, prices, tax, line totals and discounts are absent. Unknown financial keys are rejected. Restaurant line discounts remain zero and the UI fails closed until a governed server policy is implemented.
- Stable cart identity persists before submission. Lost responses replay the original order; changed payload reuse is rejected; concurrent identical requests converge to one append. Denied role, wrong branch, missing modifier, invalid financial field and malformed quantity paths have zero cart/journal effect.
- Exact-head evidence: 21/21 workflows succeeded. CI run `35907644135` passed quality job `107339226435` and unsigned Windows package `107340331172`. Table Checkout Security run `35907644305`, job `107339226826`, passed the production migration chain and real PostgreSQL authority/replay/contention suite.
- Local evidence: focused 6 files / 56 tests; full Vitest 68 files / 364 tests; TypeScript; ESLint zero errors; 128 migration validations; renderer cutover; production build (2,773 modules); and `git diff --check` passed. PR checkpoint comment `5801312258` records the evidence.
- No merge, deployment, release, force push or production-data operation occurred. Unsigned packaging is not installation, hardware or signing acceptance.

### Immediate next executable actions

1. Review PR #87 normally. Do not merge through autonomous execution.
2. Continue device-bound authority for inventory batch, reconciliation, transfer, receiving and production-completion mutations, selecting one scoped command at a time with negative/replay/contention/zero-effect proof.
3. Rebuild the authorization census against current main and complete packaged-desktop operator recovery acceptance.
4. Keep RETAIL/RESTAURANT enforcement as P1 and signing/hardware/DR/provider/regulatory gates external.

## Current checkpoint — draft PR #87 (2026-09-23 21:31 +03)

- Draft PR #87 targets main `31c81f69bac26690cb12bc897759db056dbc6642`. Verified implementation/documentation head `6ff2c747e0202aa6025c860fdd3b419bec5733a2` is clean/mergeable with no submitted reviews or inline threads.
- Exact-head workflows: 21/21 succeeded. CI run `35902033720` passed quality job `107320369037` and unsigned Windows package job `107321554649`; Table Checkout Security run `35902033597`, job `107320368201`, passed the production migration chain and real PostgreSQL legacy-grant denial contract.
- Local evidence remains focused 3 files / 46 tests, full Vitest 67 files / 362 tests, TypeScript, build (2,772 modules), 127 migration validations, renderer cutover, ESLint zero errors and `git diff --check`.
- PR checkpoint comment `5800591222` records the evidence. Offline checkout remains disabled. No merge, deployment, release, force push or production-data operation occurred.

### Immediate next executable actions

1. Review PR #87 normally; do not merge through this automation.
2. Implement the authoritative general restaurant cart command using server-derived product/modifier identity, branch/table pricing, tax, governed discounts, exact fils, scoped authority, replay/conflict and contention proof.
3. Continue device-bound inventory mutations and the rebuilt authorization census against current main.

## Current local checkpoint — post-merge main (2026-09-23 19:38:43 +03)

- Independently fetched `origin/main` at `31c81f69bac26690cb12bc897759db056dbc6642` (`Merge pull request #85 from MuhamedZanabal/integrate/security-financial-authority-20260923`). The integrated trusted-device/financial-security stack is now the base. Reported post-merge verification is 19/19 green; this runtime confirmed the SHA but could not query workflow metadata because `gh` is unavailable.
- New branch `fix/retire-legacy-table-upsert-20260923` is based exactly on that main SHA. Local commit `b6b591b` revokes PUBLIC/anon/authenticated execution of `upsert_table_order_items(uuid,uuid,uuid,uuid,jsonb,text)`, removes POS and sync-engine calls to it, rejects new `UPSERT_TABLE_ORDER_ITEMS` submissions before network or persistence, and quarantines old records unchanged as `requires_review`.
- This intentionally fails closed instead of converting renderer-owned product names, prices, tax, discounts and line totals into authoritative writes. The next implementation must derive all supported product/modifier/discount accounting on the server; the retired RPC must not be restored.
- Local evidence on the integrated tree: focused 3 files / 46 tests; full Vitest 67 files / 362 tests; TypeScript; build (2,772 modules); 127 migration validations; renderer cutover; PostgreSQL contract syntax; `git diff --check`; and ESLint zero errors / 13 existing warnings passed. Local `psql` is unavailable, so real PostgreSQL execution remains a remote-CI gate.
- Push remains blocked: `fatal: could not read Username for 'https://github.com': No such device or address`. Fetch works anonymously, but the runtime has no `gh` binary or GitHub credential helper. No remote branch/PR/CI claim applies to `b6b591b`. No merge, deployment, release, force push or production-data operation occurred; offline checkout remains disabled.

### Immediate next executable actions

1. Restore authorized GitHub write transport, push `b6b591b`, open a scoped draft PR against main, and require exact-head migration plus real PostgreSQL grant-denial evidence.
2. Implement an atomic authoritative replacement accepting product/modifier identities and quantities only, with branch/table availability, pricing, tax, governed discount policy, exact fils, tenant/branch/role/waiter scope, stable replay identity, conflict/contention and zero-effect proof.
3. Continue trusted-device classification for inventory batch, reconciliation, transfer, receiving and production completion; rebuild the authorization census against current main; replace misleading `requires_review` retry/discard semantics with explicit reconciliation dispositions.
4. Keep RETAIL/RESTAURANT enforcement as P1 and signed Windows/hardware/DR/provider/regulatory acceptance external.

## Previous checkpoint — PR #83 (2026-09-23 15:37:54 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #83 remains stacked directly on PR #82 head `1602ea9ea0ddf54d743400ec6fa18701317e5bb6`. Verified code head `af277e1ad6198b39d46ca3b052fae063c60319dc` is mergeable with no submitted reviews or inline threads. No merge is authorized and offline checkout remains disabled.
- Authenticated direct INSERT on `table_orders` and the broad insert policy are removed. `open_table_order_v2` locks the authoritative table, validates tenant, active branch, eligible branch role and assigned-waiter ownership, rejects unavailable/pending-payment tables, journals a canonical stable identity and audits the resolved order.
- The Tables and Waiter Dashboard renderer paths use the scoped command. Their operation identity is persisted before submission and retained after indeterminate responses. A waiter opening an unassigned table atomically becomes its assigned waiter; competing different operation identities serialize on the table row and converge to one open order.
- Exact-head evidence: all 21 workflows succeeded. CI #731 / run `35860984875` passed quality job `107180858375` and unsigned Windows packaging job `107182138809`. Table Checkout Security run `35860984996`, job `107180858738`, passed the production migration chain and real PostgreSQL direct-INSERT denial, wrong-branch/assigned-waiter/kitchen zero-effect denial, replay, payload-conflict, assignment and two-session competing-open convergence evidence.
- Local verification: 65 Vitest files / 348 tests, TypeScript, production build (2,772 modules), 125 migration validations, renderer creation-cutover and PostgreSQL script syntax, `git diff --check`, and ESLint zero errors / 13 pre-existing warnings passed. Local `psql` remains unavailable; exact-head CI supplied disposable PostgreSQL runtime evidence. No force push, merge, deployment, release or production-data operation occurred.
- The legacy `upsert_table_order_items` SECURITY DEFINER RPC remains a separate P0: it accepts renderer-supplied unit price, tax, discount and line totals under tenant-membership-only authority and can also create orders. This checkpoint does not claim that boundary is safe.

### Immediate next executable actions

1. Replace `upsert_table_order_items` with an authoritative branch/role/table-scoped atomic command that derives products, pricing, tax and totals server-side, preserves stable identity, and proves replay/conflict/contention/zero-effect behavior; migrate POS and queued replay before revoking the legacy RPC.
2. Continue the financial-operation census for inventory batch, reconciliation, transfer, purchase receiving and production completion; do not broaden the private stock primitive.
3. Complete offline restart, contention, corruption, quarantine and operator-recovery acceptance while checkout stays disabled, then review the stacked security chain through normal review.
4. Preserve signing, physical hardware, measured production DR, provider authorization and regulatory acceptance as external gates.

## Previous checkpoint — PR #83 (2026-09-23 15:17:56 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #83 remains stacked directly on PR #82 head `1602ea9ea0ddf54d743400ec6fa18701317e5bb6`. Verified code head `782026275fd4d5477e96753c2036f2e4c12becd6` is mergeable and has no submitted reviews. No merge is authorized and offline checkout remains disabled.
- Authenticated direct UPDATE/DELETE on `table_orders` and authenticated execution of `send_table_order_to_cashier(uuid)` are revoked. `transition_table_order_lifecycle_v2` validates tenant, active branch, branch role, assigned-waiter ownership, active order state and canonical stable identity before sending or cancelling an order.
- Cancellation is one transaction: dispatched inventory is reversed through the scoped item transition, remaining items and the order are cancelled, and the lifecycle journal plus audit evidence commit together. It locks items before the order to match the existing item-transition lock order and prevent a cancellation/dispatch lock cycle. Lost-response replay returns the original state; changed-payload reuse is rejected.
- Renderer send-to-cashier, cancellation and queued replay use the scoped lifecycle command. Operation identity is persisted before submission and retained after an indeterminate response; direct renderer status mutation is absent. Existing tenant-member INSERT is deliberately retained pending the separate order-creation authority census.
- Exact-head evidence: all 21 workflows succeeded. CI #729 / run `35859010181` passed quality job `107174332012` and unsigned Windows packaging job `107175004679`. Table Checkout Security run `35859010409`, job `107174332235`, passed the production migration chain and real PostgreSQL direct-DML/legacy-RPC denial, wrong-branch/unassigned-waiter/kitchen zero-effect denial, replay, payload conflict, concurrent send, concurrent cancellation and exact single inventory-reversal contract. Backup Restore run `35859010183` also succeeded.
- Local verification: 65 Vitest files / 347 tests, TypeScript, production build (2,772 modules), 124 migration validations, lifecycle client-cutover and PostgreSQL script syntax, `git diff --check`, and ESLint zero errors / 13 pre-existing warnings passed. The package has no `typecheck` npm alias, so `npx tsc --noEmit` supplied TypeScript evidence. Local `psql` remains unavailable; exact-head CI supplied disposable PostgreSQL runtime evidence. No force push, merge, deployment, release or production-data operation occurred.

### Immediate next executable actions

1. Audit and replace direct tenant-member table-order creation with a branch/role/table-scoped, replay-safe command, including contention and zero-effect denial tests.
2. Continue the financial-operation census for inventory batch, reconciliation, transfer, purchase receiving and production completion; do not broaden the private stock primitive.
3. Complete offline restart, contention, corruption, quarantine and operator-recovery acceptance while checkout stays disabled, then review the stacked security chain through normal review.
4. Preserve signing, physical hardware, measured production DR, provider authorization and regulatory acceptance as external gates.

## Previous checkpoint — PR #83 (2026-09-23 14:19:30 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #83 remains stacked directly on PR #82 head `1602ea9ea0ddf54d743400ec6fa18701317e5bb6`. Verified code head `c82f8fcf45302954e84a8f8c227771c977d8b512` is the current implementation checkpoint. No merge is authorized and offline checkout remains disabled.
- All six credential-less kitchen/status RPCs are revoked from authenticated execution. `transition_table_item_v2` and `transition_table_order_v2` lock the authoritative item/order, verify tenant, active branch, branch role and assigned-waiter scope, journal a canonical stable identity, reject payload substitution, and audit committed transitions.
- Dispatch and undispatch no longer expose general inventory mutation authority to waiters. A private server-only helper applies exact three-decimal sale/consumption/return effects under the scoped table command; assigned waiters can serve only their own order, kitchen users can prepare/ready but cannot dispatch, and general authenticated callers cannot execute the helper.
- Renderer and KDS callers use the scoped commands. Item identity is persisted before submission and retained across indeterminate responses. Bulk kitchen commands carry their identity through the offline queue; legacy queued records reuse their stored tenant/branch/operation scope. Replays and concurrent identical dispatches converge without a second stock movement.
- Exact-head evidence: all 21 workflows succeeded. CI #727 / run `35853169253` passed quality job `107155385167` and unsigned Windows packaging job `107156350339`. Table Checkout Security run `35853169400`, job `107155385924`, passed production migration-chain application plus real PostgreSQL legacy-denial, wrong-branch, unassigned-waiter, kitchen-dispatch denial, zero-effect, lost-response replay, payload-conflict, exact inventory reversal and two-session dispatch contention evidence.
- Local verification: 65 Vitest files / 345 tests, TypeScript, production build (2,772 modules), 123 migration validations, table-item/kitchen client cutover, `git diff --check`, and ESLint zero errors / 13 pre-existing warnings passed. Local `psql` is unavailable; exact-head CI supplied disposable PostgreSQL runtime evidence. No force push, merge, deployment, release or production-data operation occurred.

### Immediate next executable actions

1. Audit and harden `send_table_order_to_cashier` plus direct table-order cancellation/status writes with atomic branch/role authority, stable identity, replay/conflict tests and zero-effect denial evidence.
2. Continue the financial-operation census for inventory batch, reconciliation, transfer, purchase receiving and production completion; do not broaden the private stock primitive.
3. Complete offline restart, contention, corruption, quarantine and operator-recovery acceptance while checkout stays disabled, then review the stacked security chain through normal review.
4. Preserve signing, physical hardware, measured production DR, provider authorization and regulatory acceptance as external gates.

## Previous checkpoint — PR #83 (2026-09-23 10:27:00 +03)

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
