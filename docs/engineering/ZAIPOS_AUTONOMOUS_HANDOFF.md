# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current checkpoint — PR #81 (2026-09-23; code head verified)

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
