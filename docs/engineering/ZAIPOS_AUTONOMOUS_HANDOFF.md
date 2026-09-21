# ZAIPOS autonomous engineering handoff

This file is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this checkpoint.

## Current verified checkpoint

- Bahrain timestamp: 2026-09-21 22:23:15 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`.
- Main: `44dd533251acde0de35fe31a8286532857d268ef` (verified live; cash-session lifecycle merge).
- Active workstream: draft PR #75, `fix/offline-mutation-reconciliation-20260921` → `fix/device-offline-runtime-custody-20260921`, stacked on PR #74 → #72.
- Previous PR #75 head: `80e99c9bad7cd174e14ce51e975645f9ebb90c91`.
- Previous exact-head CI: run #657 / `35636704172`; 19 workflows succeeded and CI failed in `quality` step 22.
- Exact failure: `scripts/test-offline-checkout-reconciliation-postgres.mjs` received `SET\n<sale UUID>` from psql, so its UUID assertion rejected a successful RPC result. The financial call returned sale `220dfe58-4a05-4ff6-8c43-f8ae44dfd4a9`; this is test-harness evidence, not production acceptance.
- Repair commit: `3ed651cd5f7dae9abbe186a051b360e8ca66c16d` (`test: suppress psql command tags in reconciliation scalar output`). It changes scalar psql calls from `-At` to `-qAt`, preserving SQL/error behavior while suppressing command-status noise.
- New exact-head CI: run #658 / `35644372460` and 19 contract workflows were started for repair commit `3ed651c`; they were pending at this checkpoint and must not be reported as passing until terminal.

## Changed in this run

- `scripts/test-offline-checkout-reconciliation-postgres.mjs`: quiet scalar psql output so multi-statement authentication setup does not contaminate the returned UUID.
- `docs/engineering/ZAIPOS_AUTONOMOUS_HANDOFF.md`: created this durable checkpoint.

## Verification and hazards

- Verified from run #657 job `106455775889`: migrations, exact-money, checkout, RLS, refund/void, cash-session, inventory, production migration chain, tenant/branch integrity, and real checkout concurrency all passed before the reconciliation harness failed.
- Do not interpret the missing diagnostic artifact upload after step 22 as a device-registry defect; the upload step ran because the job had already failed and no unrelated log existed.
- Offline checkout remains disabled. Do not enable it from server reconciliation tests alone.
- Do not merge, force-push, deploy, release, touch production data, or claim signing/hardware/provider acceptance.
- `docs/production-readiness/REMAINING_TASKS.md` contains stale baseline text and must be reconciled only after current stacked PR evidence is settled; do not use its opening SHA as current state.

## Remaining priority

1. Inspect every workflow on exact head `3ed651c`; if CI fails, read the first genuine step log and repair on PR #75.
2. If green, extend PR #75 beyond the harness fix with concurrency/lost-response/revocation timing and denial zero-side-effect coverage where gaps remain.
3. Implement and prove native durable offline mutation queue custody, atomic persistence, crash/partial-write recovery, quarantine, and end-to-end replay without exposing lease capability to renderer JavaScript.
4. Complete trusted-device enforcement on every retained financial mutation and the exhaustive authorization inventory in PR #68 without duplicating stacked work.
5. Keep Release A blocked until integrated security/offline proof is green; keep Windows signing, store hardware, production DR and providers externally blocked until real evidence exists.

## Recovery instruction

Fetch live main, PRs #68/#72/#74/#75, and workflow runs for the current PR #75 head. Compare them with this file, inspect terminal logs for CI #658 or its successor, execute the highest-priority reproducible P0 repair, test it, commit/push to the verified branch, update this checkpoint, and continue. Never trust a pending or historical workflow as exact-head proof.
