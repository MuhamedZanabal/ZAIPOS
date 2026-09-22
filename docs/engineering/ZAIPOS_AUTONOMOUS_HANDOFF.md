# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current checkpoint — PR #81 (2026-09-23 02:21:04 +03)

- Repository `MuhamedZanabal/ZAIPOS`; main remains `44dd533251acde0de35fe31a8286532857d268ef`. Draft PR #81 branch `fix/device-bound-table-checkout-20260922` is stacked on draft PR #80 head `ba236f9ef4d05357bcacad968ea023feadd319b9`.
- Current code head: `782a886c57c982fbf1eab695e27ef31c5bec0b21`. Exact-head workflows: 20/21 completed successfully; CI #701 run `35796636091` quality job `106977324302` passed its real PostgreSQL migration/concurrency/adversarial suite, 326-test suite, lint and build. Its unsigned Windows packaging job was still running when this checkpoint was written and is not claimed successful.
- Table Checkout Security run `35796636151` and Trusted Device Enforcement run `35796636034` both passed on the exact code head. Backup Restore run `35796636325` also passed. Unsigned packaging is not signing or installation acceptance.
- Restaurant checkout now uses main-process credential custody through narrow IPC. Both cashier pending-order and table-detail paths fail closed without an authenticated provisioned desktop terminal. The renderer queue rejects new `CHECKOUT_TABLE_ORDER` entries and quarantines legacy records without replaying them.
- `checkout_table_order_v2_device` checks tenant, branch, enrolled/non-revoked device credential and settlement role before delegating to the existing atomic checkout. Owner/admin/manager/cashier may settle; waiter is explicitly denied because the authoritative inventory movement policy excludes waiter from financial stock effects. The legacy six-argument RPC is revoked from PUBLIC/anon/authenticated and the retired two-argument overload is asserted absent.
- Exact BHD inputs are canonical three-decimal strings. The stable per-order operation ID supports lost-response replay; payload substitution, wrong-device, wrong-branch, missing credential, revoked device and waiter settlement are rejected with zero extra financial effects in the disposable PostgreSQL contract.
- CI-discovered repairs during this run: initial head `7e7d01f` failed because PR #81 tried to revoke an overload already dropped by the production chain; `c9a66ef` corrected the live/retired signature inventory. That head then exposed waiter rejection inside `apply_inventory_movement`; `782a886` aligned the public settlement classification with the authoritative inventory policy and added a negative waiter test. Do not cite the failed heads as passing evidence.
- Files added/changed for the completed cutover include `supabase/migrations/20260922180215_device_bound_table_checkout.sql`, Electron credential/IPC files, `src/lib/deviceTableCheckout.ts`, both restaurant checkout UIs, queue tests, and the static/real-PostgreSQL device-bound table checkout contracts. No merge, deployment, release, force push or production-data operation occurred. Offline checkout remains disabled.

### Immediate next executable actions

1. Re-fetch PR #81 and confirm `782a886` remains its head; record terminal CI #701/Windows packaging only after it actually completes.
2. Add concurrency acceptance for two simultaneous table-checkout calls using the same and different operation IDs; require one sale/payment/stock effect and deterministic rejection of the competing identity.
3. Continue the financial RPC/authorization census for any renderer-callable mutation not yet device-bound; select the highest-risk live entrypoint and add positive/negative PostgreSQL proof before implementation.
4. Complete offline recovery/contention/corruption acceptance while keeping the immutable offline checkout gate disabled; then review the complete stacked security PR chain.
5. Preserve external signing, physical hardware, production DR, provider authorization and regulatory gates as unresolved until independently exercised.

## Previous checkpoint — PR #80 delivery collection (2026-09-22 20:48:47 +03)

- Repo `MuhamedZanabal/ZAIPOS`, main `44dd533251acde0de35fe31a8286532857d268ef`, active stack PR #80 → #79 → #78 → #77 → #76 → #75 → #74 → #72. No merge authorized.
- PR #80 code head `04f167ec70f6ad06e174f8058a88e58b9b54437e`, documentation head `ba236f9ef4d05357bcacad968ea023feadd319b9`, base #79 `e47ea2aba84bf867b01df999fa9d496897e35b77`.
- Code-head CI 20/20 success; CI #693 / `35762405187` quality and unsigned Windows packaging passed. Trusted-device `35762405109`, delivery-financial-authority `35762405333` passed real PostgreSQL tests. This is not signing, install, hardware or DR acceptance.
- Delivery collection `collect_delivery_payment_v3_device` verifies enrolled native-held credentials and tenant/branch; private verifier admits courier without broadening general finance roles. Original atomic implementation still checks active assignment. Authenticated grant on credential-less v2 revoked. Electron native brokerage, UI fail-closed, exact-fils/replay/concurrency/revocation negative tests passed. Offline checkout remains disabled.
- PR #80 initial `d796e53bad90b3618ca6c48af25fa524c766e946` was superseded by `04f167ec` after discovering shared financial verifier excludes legitimate couriers. Do not cite initial SHA as success.

## Persistent release gates

- Offline checkout hard-disabled: native orchestrator remains `{ enabled: false }`; no renderer/preload queue or credential exposure. Never enable without independent full crash, contention, corruption, reconciliation and recovery acceptance.
- Complete authorization matrix / remaining financial-RPC census; integrate and review stacked security PRs without merge until approved.
- P1 retail/restaurant authoritative segmentation, signed Windows install/upgrade/rollback, physical hardware, measured backup and restore, accessibility and operator workflow tests.
- P2 provider integrations, Bahrain VAT confirmation, accounting exports and governed AI. P3 command center, kiosk, kitchen optimization, franchise and extension support.
- External signing credentials, real hardware, production DR, provider authorization and regulatory acceptance block production release.
