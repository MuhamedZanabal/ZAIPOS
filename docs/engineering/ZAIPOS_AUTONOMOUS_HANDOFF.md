# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current verified checkpoint

- Bahrain timestamp: 2026-09-21 23:56:30 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`.
- Main: `44dd533251acde0de35fe31a8286532857d268ef`.
- Active stack: draft PR #75 `fix/offline-mutation-reconciliation-20260921` → PR #74 `fix/device-offline-runtime-custody-20260921` → PR #72 `fix/device-bound-checkout-20260919`.
- Current code head: `d7c399ce72f033d1f9df322a893cb91eb683fc19`.
- Exact-head CI for `d7c399c` had not yet registered when this checkpoint was written; it is pending evidence, not a pass. The immediately preceding documentation head `55030e4c00f7e3554eb546ee6a2792080a9f04d6` passed all twenty workflows in CI #674.
- Exact-head CI #672 / `35650600431` for `9f82085`: quality job `106501788786`, unsigned Windows-package job `106502644817`, and all twenty exact-head workflows succeeded. This included production PostgreSQL migrations, concurrent offline reconciliation, Catalogue Import, lint, the 297-test suite, build and unsigned Windows packaging. This is not signing or installation acceptance.
- Previous repair: `3ed651cd5f7dae9abbe186a051b360e8ca66c16d` fixed psql scalar parsing. Exact-head CI #659 quality and all parallel contracts passed; its Windows package result is historical, not proof for the current head.

## Work completed in the latest run

- `099af57174164f0f00e593f7cf5d7bfe7f846e8f` — added main-process native offline mutation custody:
  - safeStorage-encrypted payloads; plaintext lease token is never serialized;
  - immutable mutation/lease/tenant/branch/device identity;
  - complete-state write-ahead journal and startup recovery;
  - corruption, scope, expired-authority and authoritative rejection quarantine;
  - network failure retention and exact sale-result removal;
  - no renderer/preload queue or capability IPC; offline checkout remains disabled.
- `cb2ff72a2444d1a48cb84233c215470c1324c550` — extended the real PostgreSQL contract so two simultaneous submissions of one mutation converge on one sale, one payment/till effect and one stock decrement.
- `66cb8e225c585565c3073c99b28842bc9c137e1b` — canonicalized protected JSON independent of object-key order; rejected cyclic, non-finite, non-JSON and over-1 MiB envelopes before persistence.
- `acca898794e23146473d4b1353c60eec4a449c38` — quarantines malformed HTTP-success reconciliation JSON rather than escaping an exception; proves journal recovery both before the primary state write and before journal deletion.
- `f4118527bcd3069f81a4762728b0d041868e178d` — adds a main-process-only offline checkout orchestrator with an explicit disabled release gate, serialized bounded drains, quarantine continuation and network-retention stop behavior. No IPC or preload surface was added.
- `e2b827d5085496a0f5c98aedf7d56fabdcaec069` — snapshots the release gate at construction so later mutation of the caller's options object cannot enable financial work.
- `0d0edbe357b5aebbb32d72576577bdcabf496852` — adds a dormant authenticated-reconnect coordinator after successful native online checkout. It reuses or refreshes main-process lease authority and initiates a serialized drain only when the immutable release gate is enabled; background failure is logged without converting a committed online sale into an apparent failure.
- `9f8208574a62e23aceb09a41237d2ba5dc66f073` — adds real queue/orchestrator boundary tests proving lease rotation quarantines stale-lease work while replacement-lease work commits, and revocation quarantines every queued mutation with zero network effects.
- `d7c399ce72f033d1f9df322a893cb91eb683fc19` — treats a response-body stream failure after successful HTTP headers as a lost response: the encrypted mutation remains durable, restart reconstructs the queue, and retry sends the byte-identical mutation payload so the server's idempotency contract can return the original sale result.

## Local verification

- `npm test`: 60 files, 298 tests passed.
- `npm run lint`: zero errors; 13 pre-existing warnings.
- `npm run build`: success; 2,768 modules transformed.
- `node scripts/test-device-credential-vault-contract.mjs`: passed.
- Focused native queue/orchestrator/coordinator suites: 23 tests passed. The new body-stream lost-response/restart test was observed red before the queue repair.
- A local PostgreSQL client/server is unavailable in this runtime (`pg_isready` and `psql` are not installed); the real reconciliation contract must therefore be re-proven by the exact-head CI quality job.
- Standalone `tsc -p tsconfig.electron.json --noEmit` remains blocked by pre-existing `import.meta.env` and `manager-authorization.ts` typing errors; CI build and lint are green.

## Hazards and boundaries

- Offline checkout is still disabled. The new queue is recovered at Electron startup but intentionally has no renderer enqueue/reconcile surface.
- Never expose lease token, credential, encrypted records or native queue custody to renderer JavaScript.
- Do not merge, force-push, deploy, release, touch production data, or claim signing/hardware/provider acceptance.
- `docs/production-readiness/REMAINING_TASKS.md` has stale opening status and must not be treated as current authority without reconciliation.
- Direct local HTTPS push lacks credentials; commits were published atomically through the authorized GitHub connection. Do not repeat failed credential prompts.

## Remaining priority

1. Verify exact-head CI for `d7c399c`, especially the real PostgreSQL reconciliation contract; diagnose any non-green job before further implementation.
2. Design the native capture trigger and operator recovery surface without exposing lease capability or enabling offline checkout; retain the hard-disabled release gate until end-to-end acceptance exists.
3. Complete trusted-device enforcement for every retained financial mutation and finish PR #68's exhaustive authorization matrix without duplicating stacked work.
4. Keep Release A blocked until integrated offline/device/authorization proof is green. Signing, physical hardware, production DR and provider integrations remain external gates.

## Recovery instruction

Fetch live main, PRs #68/#72/#74/#75 and the current PR #75 head. Compare them with this file; CI #674 is proof only for documentation head `55030e4c`. Inspect exact-head workflows for `d7c399c`; if green, proceed to the native capture/operator-recovery design without exposing capabilities or enabling checkout. Pending or historical workflows are never exact-head proof.
