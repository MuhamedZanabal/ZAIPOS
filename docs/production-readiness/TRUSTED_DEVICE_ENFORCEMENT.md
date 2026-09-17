# SEC-004: trusted device enforcement

## Verified reproduction

Baseline main: `f7926fa2ddfe83b41a1549c6208b21e06495eba7`. PR66 head: `54ba0b93f34efaa543ea26cdbcd791dc0b212653`. Dedicated run **35188046578**, job **105094272848**, failed the intended assertion after applying the production migration chain.

The authenticated cashier fixture registered an original UID. After the administrator fixture revoked that row, the original UID heartbeat correctly failed. The same cashier then registered a replacement UID without manager enrollment. A new `checkout_sale_v2` request bearing the original revoked UID in its mutation reference also committed: **one sale, 1000 till fils, stock reduced from 2.000 to 1.000**, while the original device row remained revoked. The test checks these persisted effects before failing.

This proves that heartbeat revocation is not a financial transaction device boundary. It does not prove anonymous access, cross-tenant access, stolen credentials or a bypass of operator authorization. The fixture uses a valid in-branch cashier identity. Source trace agrees: `deviceIdentity.ts` reads renderer localStorage; `deviceHeartbeat.ts` logs heartbeat errors without blocking checkout; checkout payload and sync RPCs contain no verified device credential.

The existing device-registry contract remains useful for UID heartbeat denial, tenant/branch scope and RLS. It never established trusted device enrollment. PR66 remains a RED diagnostic draft and must not be merged as a completed fix.

## Proposed bounded design — authorization required

The latest execution directive requires approval before architectural changes. The following is a concrete proposed device boundary, not an implemented capability or a replacement for Supabase authentication:

1. Retain Supabase login and current server role checks as operator authority. Treat UID as a public label only.
2. Add manager-approved, branch-bound enrollment with an expiring single-use activation code. Store only hashes of high-entropy activation/device credentials; record enrollment, rotation and revocation audit events. No cashier heartbeat can grant enrollment or move an enrolled device between branches.
3. Hold the device credential in Electron main, protected by Windows-backed encryption, never renderer localStorage or returned through IPC. Fail closed when secure native storage is unavailable. A native broker permits only reviewed financial RPCs to the configured Supabase origin, injects the credential over TLS, and forwards the current operator token for normal authorization. It must not become a general HTTP proxy or credential-export IPC.
4. Every financial server entry point verifies credential hash, enrolled state, tenant, branch and revocation before changing state. Preserve existing payload-bound transaction identity and accounting algorithms. Passing or copying a UID without its credential confers no authority. Browser management access remains role-controlled; browser financial entry points cannot silently bypass the desktop device requirement.
5. Recovery/read-only receipt lookup must be separately authorized and nonmutating so revocation does not erase reconciliation evidence. A retry capable of a new effect requires current device authority. Never use an idempotency key as a credential.
6. Offline sales require a separately specified, bounded cached authorization lease. Immediate revocation cannot reach a disconnected terminal. On reconnect, revoked or expired authority quarantines unsynchronized requests for manager reconciliation; retain every operation ID and payload, and never silently report them committed or discard physical-sale evidence. Lease duration and store policy require approval before implementation.
7. Roll out in stages: enroll terminals, preserve and reconcile existing offline queues, upgrade clients, then enforce the new financial boundary. Do not retroactively rewrite historical sales or invent device proof for old records. No silent legacy bypass after enforcement.

This provides proof of a protected device credential, not TPM-backed hardware attestation. A compromised Windows account able to extract credentials remains a stated limitation. Replacing a failed terminal or recovering after profile loss requires authorized re-enrollment, not copying a UID. If cryptographic hardware identity is mandatory, TPM/attestation capabilities require separate evaluation and physical acceptance.

## Acceptance required before closure

Test unknown/replacement/copied UID, absent/wrong credential, replayed activation, revoked credential, wrong tenant/branch, cross-operator abuse, secure-storage failure, IPC sender/origin/allowlist boundaries, credential rotation, restart, queued requests before and after revocation, expiry and reconnection. Prove both denial and zero persisted financial effects. Preserve accepted checkout concurrency, exact-fils, historical evidence and replay tests. Complete migration/legacy-client and backup/recovery procedures for enrollment state. Physical/offline acceptance cannot be inferred from mocks.

State: **REPRODUCED; architectural implementation AWAITING_AUTHORIZATION**. Next safe action is review/approval of the bounded device credential and offline policy above; independent repository tasks remain executable.
