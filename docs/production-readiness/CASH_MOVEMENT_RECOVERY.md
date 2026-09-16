# Cash movement retry and recovery

Status: implementation under PR62 verification. Session opening and closing retry identity remain separate work; this procedure covers manual cash in/out only.

## Operator procedure

1. Open the correct till. Assign a unique voucher reference to the actual physical movement, for example `FLOAT-20260915-001`. References are case-sensitive, 8–128 characters, and unique within the tenant. Enter exact three-decimal BHD and a reason. Do not record a supplier payment here as a substitute for its payable settlement.
2. Record once. The application saves the reference, original session and exact request before calling PostgreSQL. If a response is lost, keep the device data and voucher. Reopen **Cash movement recovery**, including when the original session is closed, and retry that saved request.
3. A confirmed receipt remains visible until **Start another physical movement** is explicitly selected. Replaying the original reference returns the original movement ID and does not add money again. A changed payload or actor cannot reuse it. An existing reference bound to a different request rejects this candidate; verify the original voucher before starting another movement.
4. To abandon an uncertain request, use **Resolve cancellation**. The server competes for the same reference lock. If the movement already committed, recovery confirms that recorded movement. If it did not commit, the server records an immutable cancellation that prevents a delayed request from recording it. Only a terminal result allows another physical movement. Cancellation never reverses physical cash or erases accounting evidence; a real correction needs a new explained movement.
5. Missing browser lock support, unavailable/full storage or corrupt recovery data blocks new submissions. Preserve the affected device data and reconcile the original voucher against `cash_movement_operations`, `cash_movements` and audit evidence. A revoked user must regain authorized access through the normal manager process before recovering a request; no role bypass exists.

## Production invariant

One tenant/reference binds one actor, branch, original session, type, exact fils and reason. The immutable operation receipt, movement, till counters and audit commit in one PostgreSQL transaction. Concurrent retries serialize on a transaction-scoped advisory lock for that tenant/reference. A hash collision can only serialize unrelated requests; it cannot change payload binding. The existing locked cash movement core remains the money authority. Authorization is re-evaluated before replay. Legacy direct mutation RPC access is revoked from application roles, so older clients must upgrade.

The browser uses Web Locks to serialize the local journal across windows for an actor. The journal is stored before any network effect; terminal receipts are retained. This is persisted restart recovery, not a claim of hardware-level power-loss durability. Cleared browser profiles, disk failure, another device, managed Auth backup and physical voucher custody require operator reconciliation. The server reference still prevents duplication if the original voucher is reused. Reasons can contain sensitive business information; use operational descriptions and protect the local user profile. No credentials are stored in the journal.

## Evidence and limitations

PostgreSQL RED run 34908245777 reproduced two 1.001 BHD calls producing 2002 fils for one physical float. The replacement contract checks exact replay after later activity, concurrent retries, cancellation races, transaction rollback, session closure, payload and branch substitution, revoked roles and legacy RPC denial. UI tests check response loss/remount, failed persistence, retained receipts, earlier-session recovery and corrupt journal rejection. CI and release quality gates run the real PostgreSQL contract.

Opening/closing session operation identity, customer-credit/supplier settlement till integration, multi-register selection and physical drawer custody remain in the production ledger. Deploy the migration and updated UI together; recover any ambiguous legacy movements from their existing history before submitting a new reference. Take a verified backup before upgrade. Do not drop the new operation ledger during rollback: it is permanent replay evidence. Roll back to a compatible client or forward-fix the UI; do not re-enable the legacy bypass.

Upgrade boundary: drafts written by the earlier unscoped client (`zaipos:cash-movement-draft:*`) block fresh submissions. Preserve each draft; an authorized operator must match its reference/session/payload to server operation and movement evidence, recover or cancel it using the original actor, and only then remove that reconciled legacy draft. Do not clear an entire profile to bypass this check.
