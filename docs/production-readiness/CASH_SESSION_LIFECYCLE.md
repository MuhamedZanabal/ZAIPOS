# Cash session lifecycle recovery (CASH-002B)

Baseline: main `f7926fa2ddfe83b41a1549c6208b21e06495eba7`. Development PR65; not merged or deployed. PostgreSQL RED run 35187126061 proved that an opening retried after its original session was closed creates a second session. UI RED independently proved the absence of a saved opening intent before the network call.

## Contract

`apply_cash_session_v2` accepts a UUID operation identity, an explicit opening or closing request, and an optional cancellation resolution. The client generates the identity and saves the original actor, branch, register/session and exact decimal strings before sending. PostgreSQL binds that identity to the actor, scope, operation type and canonical integer-fils payload. Every call, including recovery, checks current role, active account and branch. Closing must identify a session in the supplied scope. Opening validates the active register through the existing hardened primitive.

The operation ledger, session mutation and audit commit atomically. Execution and cancellation share one transaction advisory lock. A matching replay returns the original receipt after closure or subsequent sessions; it does not read current counts into the saved request or modify a historical session. A changed actor or payload is denied. Concurrent distinct opening intents remain subject to the existing unique open-register constraint. A second distinct closing cannot overwrite a closed session.

Cancellation is an immutable no-effect outcome only if the original operation has not committed. If execution already committed, cancellation returns that recorded receipt; it never closes an opened register or reopens a closed one. Cancelling a closing intent leaves the session open and permits a new, explicitly counted closing intent. Late requests for a cancelled identity remain cancelled. A database error rolls back both outcome and effects; the original identity can be retried.

The original hardened opening/closing functions remain internal primitives. Application-role execution of those non-idempotent legacy APIs is revoked. Existing cash-movement authority and its separate journal are unchanged.

## Operator procedure

1. Select the intended branch. Enter an explicit exact opening amount, or all four closing counts including zero. The current interface opens the default register; named-register selection remains a separate multi-terminal audit item.
2. Submit once. On uncertainty, retain this device profile. The saved request remains visible at the top of Cash Register, even if the original session is now closed or another branch/session is selected. Input controls cannot replace its payload.
3. Choose **Retry saved session request**. The original branch, identity and counts are sent. A confirmed receipt identifies the original session; check the current register before selling.
4. To abandon an unconfirmed intent, choose **Resolve session cancellation**. Read the returned outcome: recorded means the original operation committed; cancelled means no operation under that identity can later change the register.
5. Choose **Acknowledge session receipt** only after reviewing the terminal outcome. This clears the local receipt, not server evidence. A new operation receives a new identity. A pending request cannot be acknowledged away.
6. Unreadable/full/unavailable storage or absent Web Locks blocks new operations. Preserve device data and reconcile `cash_session_operations`, session rows and audit records. Do not clear the profile or use another identity merely to bypass uncertainty. A revoked operator requires normal authorized account resolution; no recovery permission bypass exists.

## Deployment and recovery boundaries

Take a verified backup, reconcile uncertain legacy requests against session/audit history, and deploy the migration with compatible clients. Older clients are denied the legacy mutation APIs and must upgrade. The server cannot reconstruct the identity or original input of a legacy request that never recorded it. Do not re-enable legacy grants during rollback. Forward-fix or install a compatible client while retaining the immutable operation ledger.

Local Web Locks coordinate windows using the same profile and origin. Server identity and row/unique locks coordinate different terminals, but distinct identities are distinct business intents. Local storage is restart recovery, not certified disk/power-loss durability. Profile deletion, disk loss and cross-device operator recovery require preserved records and manager reconciliation. Never log the whole request or credentials. The journal contains business counts and must be protected with the device profile.

The backup rehearsal now seeds both manual-cash and session-operation evidence, fingerprints every public table and compares the restored rows. Supabase Auth, external storage and local journals retain their separately documented recovery boundaries. Physical drawer custody and power-loss acceptance are external.

## Verification

Contracts cover duplicate/concurrent opening and closing, response loss, module/UI remount, subsequent activity, cancellation races, changed payload, cross-actor/branch/tenant, banned/deleted accounts, inactive branches, explicit exact counts, corrupt/full storage, legacy denial, immutable operation rows and audit-failure rollback. CI and release quality gates run the real PostgreSQL lifecycle contract. See the production ledger for observed results; the presence of tests is not a passing result.
