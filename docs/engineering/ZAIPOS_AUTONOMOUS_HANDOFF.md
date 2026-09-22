# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current verified checkpoint

- Bahrain timestamp: 2026-09-22 13:46 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`.
- Main: `44dd533251acde0de35fe31a8286532857d268ef` (unchanged).
- Active stack: draft PR #76 `fix/device-bound-cash-movement-20260922` → PR #75 `fix/offline-mutation-reconciliation-20260921` → PR #74 `fix/device-offline-runtime-custody-20260921` → PR #72 `fix/device-bound-checkout-20260919`.
- Open PRs are now ten: #64, #66, #68, #69, #70, #71, #72, #74, #75, #76. All draft. No merge is authorized.
- Parent published documentation head (PR #75): `23f36446b92ed7c47311e33a9e3348786550ea3e` (`docs: record green operation identity CI`).
- Parent published code head (PR #75): `b4cae4eceea460d41e0e21284b63d0285a81ec6c` (`fix(device): bind capture and retry identity`).
- Exact-head CI for `85a9383f` (then-current PR #75 docs head): all 20 workflows succeeded, including CI #679 / `35677864681`. Historical proof only for that SHA.
- Previous native-recovery code head: `0ad6454dc14c3f3d6b2712344bb4740afc58c88d`. Exact-head CI #677 / `35660056645` succeeded. Historical proof only for that SHA.
- PR #76 initial code head `9415da370efe4a4312117481dfef6e9091a0029c` (`fix(device): bind manual cash movements`) is **not** exact-head green. Quality job `106602351809` (CI run `35682532338`) failed `test-cash-mutation-authority-postgres.mjs` because authenticated callers were revoked from `record_cash_movement_v2` while the existing happy-path still invoked it. Trusted-device job `106602351554` (run `35682532347`) failed a `cash_sessions` snapshot that mixed `count(*)` with non-aggregated `total_in_fils` / `total_out_fils`.

## Work completed in this run

PR #76 already bound manual cash movements. This run repairs the exact-head contracts without enabling offline checkout:

- Cash mutation authority and cash replay PostgreSQL contracts now enroll a manager-approved terminal, activate the credential through `service_role`, and exercise `record_cash_movement_v3_device` / `cancel_cash_movement_v3_device` for every authorized effect, replay, cancellation, concurrent close, and closed-session case.
- Authenticated `record_cash_movement_v2` remains an explicit deny. Wrong-branch, sub-fils, peer-actor and payload-substitution cases still fail closed on the production device path.
- Trusted-device cash snapshots use scalar subqueries so session totals are not aggregated with `count(*)`.
- Native custody now also fails closed for unprovisioned cash movement.

Local verification cannot prove the PostgreSQL contracts; exact-head CI quality and trusted-device for the new SHA are required before attributing green evidence to this repair.

## Local verification

- `npx vitest run`: 61 files, 315 tests passed.
- Focused native cash/device suites: 6 files, 34 tests passed.
- ESLint on the touched Electron/cash/test files: zero errors.
- `git diff --check`: passed.
- A local PostgreSQL client/server is unavailable in this runtime; the repaired cash and trusted-device contracts must be re-proven by exact-head CI.
- Standalone `tsc -p tsconfig.electron.json --noEmit` remains blocked by pre-existing `import.meta.env` and `manager-authorization.ts` typing errors.

## Files modified in this run

- `scripts/test-cash-mutation-authority-postgres.mjs`
- `scripts/test-cash-replay-postgres.mjs`
- `scripts/test-trusted-device-enforcement-postgres.mjs`
- `src/test/desktop/device-credentials.test.ts`
- `docs/engineering/ZAIPOS_AUTONOMOUS_HANDOFF.md`

PR #76 already contained:

- `supabase/migrations/20260922030000_device_bound_cash_movement.sql`
- `electron/services/device-credentials.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `electron/types.ts`
- `src/types/electron.d.ts`
- `src/lib/cashMovementRecovery.ts`
- `src/modules/cash/Cash.tsx`
- `src/test/cash-movement-ui.test.tsx`
- `src/test/cash-recovery-journal.test.ts`
- `src/test/cash-retry-ui.test.tsx`
- `src/test/desktop/device-credentials.test.ts`

## Hazards and boundaries

- Offline checkout is still disabled. Capture and drain throw until the gate is explicitly enabled in tests; production wiring remains `{ enabled: false }`.
- Never expose lease token, credential, encrypted records or native queue custody to renderer JavaScript.
- Do not merge, force-push, deploy, release, touch production data, or claim signing/hardware/provider acceptance.
- `docs/production-readiness/REMAINING_TASKS.md` has stale opening status and must not be treated as current authority without reconciliation.
- `record_cash_movement_v2` / `cancel_cash_movement_v2` remain the exact-fils primitives but are no longer executable by authenticated clients. Browser cash UI fails closed unless native `window.electron.cashMovement` is present.
- `9415da3` is not proof for this repair SHA. Pending or historical workflows are never exact-head proof.

## Remaining priority

1. Wait for exact-head CI of this PR #76 repair. If quality/trusted-device are green, continue trusted-device enforcement for refund, return, void, customer credit, supplier payments and delivery finance without duplicating stacked PR #72/#74/#75/#76 work.
2. Keep the hard-disabled release gate until the complete offline checkout acceptance matrix is independently proven, including an operator-visible recovery UI that does not expose capability material.
3. Finish PR #68's exhaustive authorization matrix without duplicating the census.
4. Keep Release A blocked until integrated offline/device/authorization proof is green. Signing, physical hardware, production DR and provider integrations remain external gates.

## Historical checkpoint (2026-09-22 05:07 +03)

Previous published PR #75 documentation head `85a9383f` / code `b4cae4e`. Exact-head CI #679 for `85a9383f` passed all twenty workflows; later PR #75 documentation head `23f3644` must be verified independently before attributing #679 to it.

Work already on the parent branch before this run:

- `099af57174164f0f00e593f7cf5d7bfe7f846e8f` — native encrypted offline mutation custody, WAL, quarantine; no renderer/preload queue IPC; checkout disabled.
- `cb2ff72a2444d1a48cb84233c215470c1324c550` — real PostgreSQL concurrent reconciliation: one mutation, one sale/payment/till/stock effect.
- `66cb8e225c585565c3073c99b28842bc9c137e1b` — canonical protected JSON; reject cyclic/non-finite/non-JSON/oversize envelopes.
- `acca898794e23146473d4b1353c60eec4a449c38` — malformed success JSON quarantine; journal recovery before primary write and before journal deletion.
- `f4118527bcd3069f81a4762728b0d041868e178d` — main-process orchestrator with disabled release gate and bounded drains.
- `e2b827d5085496a0f5c98aedf7d56fabdcaec069` — immutable snapshot of the disabled release gate.
- `0d0edbe357b5aebbb32d72576577bdcabf496852` — dormant authenticated-reconnect coordinator after successful native online checkout.
- `9f8208574a62e23aceb09a41237d2ba5dc66f073` — lease rotation and revocation quarantine proof.
- `d7c399ce72f033d1f9df322a893cb91eb683fc19` — body-stream lost-response retention and byte-identical replay.
- `4567fd93fbf8b7459fc91b3cc34d48240058b464` — documentation checkpoint for lost-response replay. Exact-head CI #676 succeeded.
- `0ad6454dc14c3f3d6b2712344bb4740afc58c88d` — persist offline capture before operator recovery. Exact-head CI #677 succeeded.
- `b4cae4eceea460d41e0e21284b63d0285a81ec6c` — bind capture and retry identity.

Earlier historical CI: #672 / `35650600431` for `9f82085`; #674 for documentation head `55030e4`; psql scalar parsing repair `3ed651c` / CI #659. Those SHAs are not proof for later heads.

## Recovery instruction

Fetch live main, open PRs #64/#66/#68/#69/#70/#71/#72/#74/#75/#76 and the current PR #76 head. Compare them with this file. CI #679 is proof only for `85a9383f`. `9415da3` is not proof for later PR #76 SHAs. If this repair's exact-head quality and trusted-device jobs are green, continue the next financial-mutation device boundary (return/void). Do not enable offline checkout. Pending or historical workflows are never exact-head proof.

Scheduled hourly automation title: `ZAIPOS Autonomous Engineering` (task `01a0c5ed-9990-7530-adea-231f31a9ee61`, every 1 hour). Scheduled invocations reconstruct continuity from this file and live GitHub state; they do not continue between invocations and may not append to the originating chat.
