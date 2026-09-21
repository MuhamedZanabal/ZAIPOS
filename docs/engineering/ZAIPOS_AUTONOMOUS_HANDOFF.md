# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current verified checkpoint

- Bahrain timestamp: 2026-09-21 23:10:33 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`.
- Main: `44dd533251acde0de35fe31a8286532857d268ef`.
- Active stack: draft PR #75 `fix/offline-mutation-reconciliation-20260921` → PR #74 `fix/device-offline-runtime-custody-20260921` → PR #72 `fix/device-bound-checkout-20260919`.
- Current code head: `e2b827d5085496a0f5c98aedf7d56fabdcaec069`.
- Exact-head CI for `e2b827d` is running and is not yet evidence. Earlier head `2c4cd7786cfeb7f16b7cf15330e949dd692a9264` had CI #666 / `35648191322`: quality job `106493738094`, unsigned Windows-package job `106494792604`, and all twenty exact-head workflows succeeded. This included production PostgreSQL migrations, concurrent offline reconciliation, Catalogue Import, lint, the then-285-test suite, build and unsigned Windows packaging. This is not signing or installation acceptance.
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

## Local verification

- `npm test`: 59 files, 290 tests passed.
- `npm run lint`: zero errors; 13 pre-existing warnings.
- `npm run build`: success; 2,768 modules transformed.
- `node scripts/test-device-credential-vault-contract.mjs`: passed.
- Focused native queue/orchestrator suites: 15 tests passed. The orchestrator tests were observed red before implementation and before immutable-gate hardening.
- Standalone `tsc -p tsconfig.electron.json --noEmit` remains blocked by pre-existing `import.meta.env` and `manager-authorization.ts` typing errors; CI build and lint are green.

## Hazards and boundaries

- Offline checkout is still disabled. The new queue is recovered at Electron startup but intentionally has no renderer enqueue/reconcile surface.
- Never expose lease token, credential, encrypted records or native queue custody to renderer JavaScript.
- Do not merge, force-push, deploy, release, touch production data, or claim signing/hardware/provider acceptance.
- `docs/production-readiness/REMAINING_TASKS.md` has stale opening status and must not be treated as current authority without reconciliation.
- Direct local HTTPS push lacks credentials; commits were published atomically through the authorized GitHub connection. Do not repeat failed credential prompts.

## Remaining priority

1. Inspect exact-head CI for `e2b827d`; diagnose the first genuine failing step if any.
2. Add a tested dormant authenticated-reconnect hook that refreshes native lease authority and drains only when the immutable release gate is enabled; keep capture and the hook unreachable from renderer while the gate is false.
3. Prove lease rotation/revocation quarantine, restart/lost-response replay against the real server RPC and multi-terminal contention end to end.
4. Complete trusted-device enforcement for every retained financial mutation and finish PR #68's exhaustive authorization matrix without duplicating stacked work.
5. Keep Release A blocked until integrated offline/device/authorization proof is green. Signing, physical hardware, production DR and provider integrations remain external gates.

## Recovery instruction

Fetch live main, PRs #68/#72/#74/#75 and the current PR #75 head. Compare them with this file. Inspect exact-head CI for `e2b827d` and diagnose the first genuine failing log if any; CI #666 remains proof only for earlier head `2c4cd77`. Then implement the dormant authenticated-reconnect hook or the next higher-priority reproducible P0 task, test it, publish a coherent fast-forward commit, update this checkpoint and continue. Pending or historical workflows are never exact-head proof.
