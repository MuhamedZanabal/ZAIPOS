# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current verified checkpoint

- Bahrain timestamp: 2026-09-22 20:16 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`; main `44dd533251acde0de35fe31a8286532857d268ef`.
- Active stack: draft PR #79 `fix/device-bound-supplier-payment-20260922` → PR #78 → PR #77 → PR #76 → PR #75 → PR #74 → PR #72. No merge is authorized.
- PR #79 code head: `b6f724f1de51bff3a657d7344cfce93d25011446`, base PR #78 head `ac1ea4167abd646da5ce14046cda2faf04f4381c`.
- Exact-head CI for `b6f724f1`: all 20 workflows succeeded. CI #690 / `35758779913` passed quality job `106851215457` and unsigned Windows packaging job `106852379222`; trusted-device run `35758780011` / job `106851214164`, supplier-subledger run `35758780093`, and backup/restore run `35758779922` / job `106851216206` passed against real PostgreSQL. This is not signing, installation, hardware or production-recovery acceptance.
- Initial PR #79 code head `6f514ccdecfaace19eef223f837aa4d8387bcfc9` failed trusted-device run `35737085903` because its fixture duplicated trigger-created branch cutovers, and backup/restore run `35737085849` because supplier and customer-credit fixtures reused the same unique credential hash. Repair `b6f724f1` removed the redundant insert and isolated the credential secret; the failed SHA is not proof.
- Local source-equivalent verification: TDD red reproduced the absent native broker; focused native custody 13 tests; full 61 files / 319 tests; `npx tsc --noEmit`; migration validation (117); native credential/offline-lease vault and supplier static contracts; ESLint zero errors / 13 pre-existing warnings; production build (2,768 modules); PostgreSQL script syntax and `git diff --check` all passed.

## Work completed in the supplier-payment run

- Authenticated execution of credential-less `record_supplier_payment_v1` is revoked.
- `record_supplier_payment_v2_device` verifies enrolled credential, tenant, branch, supplier, user and manager/owner/admin role before replay or financial effect, then delegates to the existing exact-fils/idempotency primitive.
- Native custody validates canonical positive bigint fils, supported payment method, optional canonical reference/note and stable operation identity. No renderer IPC was added because no supplier-payment renderer workflow exists on this branch.
- Real-PostgreSQL coverage proves legacy bypass, missing/copied/wrong-branch credential and cashier-role denial, exactly-once replay, modified-payload rejection, revocation-before-replay and zero ledger/operation/audit effects for rejected calls.
- The supplier-subledger and backup/restore contracts now use distinct enrolled-terminal credentials; trigger-owned future-branch cutover creation is not duplicated. Offline checkout remains disabled.

## Supplier-payment run files

- `supabase/migrations/20260922165100_device_bound_supplier_payment.sql`
- `scripts/test-device-bound-supplier-payment-postgres.mjs`
- `scripts/test-supplier-subledger-postgres.mjs`
- `scripts/test-supplier-subledger.mjs`
- `.github/workflows/trusted-device-enforcement.yml`
- `electron/services/device-credentials.ts`
- `src/test/desktop/device-credentials.test.ts`

## Previous verified checkpoint (customer credit)

- Bahrain timestamp: 2026-09-22 15:48 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`; main `44dd533251acde0de35fe31a8286532857d268ef`.
- Active stack: draft PR #78 `fix/device-bound-customer-credit-20260922` → PR #77 → PR #76 → PR #75 → PR #74 → PR #72. No merge is authorized.
- PR #78 code head: `aa6f0a2056ca6f100d17b3263fd5900bd3a3d9be`, base PR #77 head `244f253b1d2456b7efa8158a6a72715221087726`.
- Exact-head CI for `aa6f0a20`: all 20 workflows succeeded. CI #687 / `35728723827` passed quality job `106748684627` and unsigned Windows packaging job `106749690956`; trusted-device run `35728724028` / job `106748686143` passed the real-PostgreSQL device-bound customer-credit contract. This is not signing or installation acceptance.
- Initial PR #78 code head `62ea66dd3f6de7306b3146e347cf7adf3776c5fe` failed trusted-device run `35728431022` because the test duplicated profiles already created by the canonical auth trigger. Repair `aa6f0a20` removed only the redundant fixture insert; that failed SHA is not proof.
- Local source-equivalent verification: focused native custody 12 tests; full 61 files / 318 tests; `npx tsc --noEmit`; migration validation (116); native credential/offline-lease vault contract; ESLint zero errors / 13 pre-existing warnings; production build (2,768 modules); PostgreSQL script syntax and `git diff --check` all passed.

## Work completed in the customer-credit run

- Authenticated execution of credential-less `record_customer_credit_payment_v1` is revoked.
- `record_customer_credit_payment_v2_device` verifies enrolled credential, tenant, branch, customer, user and role scope before replay or financial effect, then delegates to the existing exact-fils/idempotency primitive.
- Native credential custody validates canonical positive bigint fils, method, reference and operation identity and injects the credential only for the RPC request. No renderer IPC was added because no customer-credit payment renderer workflow exists on this branch.
- Real-PostgreSQL coverage proves legacy bypass, missing/copied/wrong-branch credential denial, exactly-once replay, modified-payload rejection, revocation-before-replay and zero balance/entry/operation/audit effects for rejected calls.
- Existing customer-credit subledger coverage now uses an enrolled terminal for its authorized payment path. Offline checkout remains disabled.

## Customer-credit run files

- `supabase/migrations/20260922123201_device_bound_customer_credit_payment.sql`
- `scripts/test-device-bound-customer-credit-postgres.mjs`
- `scripts/test-customer-credit-subledger-postgres.mjs`
- `.github/workflows/trusted-device-enforcement.yml`
- `electron/services/device-credentials.ts`
- `src/test/desktop/device-credentials.test.ts`

## Previous verified checkpoint (return and void)

- Bahrain timestamp: 2026-09-22 15:14 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`; main `44dd533251acde0de35fe31a8286532857d268ef`.
- Active stack: draft PR #77 `fix/device-bound-return-void-20260922` → PR #76 `fix/device-bound-cash-movement-20260922` → PR #75 → PR #74 → PR #72. No merge is authorized.
- PR #77 code head: `4b0773ac37257b8e4c20231169d9b164ff3b5ed9` (`fix(device): bind returns and voids to trusted terminals`), base PR #76 head `c9d8c0246e8cb635a2ae290b05156bc565f8ea7c`; draft and mergeable.
- Exact-head CI for `4b0773ac`: all 20 workflows succeeded. CI #684 / `35725327419` passed quality job `106737485630` and unsigned Windows packaging job `106738400071`; trusted-device run `35725327471` / job `106737485879` passed the new real-PostgreSQL device-bound return/void contract. This is not signing or installation acceptance.
- Local source-equivalent verification: focused 3 files / 18 tests; full 61 files / 317 tests; `npx tsc --noEmit`; migration validation (115); native credential/offline-lease vault contract; ESLint zero errors / 13 pre-existing warnings; production build (2,768 modules); `git diff --check` all passed.

## Work completed in the current run

- Authenticated execution of credential-less `process_sale_return_v2` / `process_sale_void_v2` is revoked by the new terminal migration.
- Device-bound v3 wrappers verify the enrolled credential and tenant/branch/sale scope before replay, sale lookup or any financial effect.
- Return and void dialogs now fail closed without the supported desktop bridge and use native OS-protected credential custody through narrow IPC.
- Native validation rejects scope substitution, malformed identities, quantities and reason data before credential decryption or network access.
- New real-PostgreSQL contract covers legacy bypass, missing/copied/wrong-branch credentials, exactly-once return/void replay, revocation-before-replay, and zero money/stock/audit effects for rejected requests.
- Offline checkout remains disabled.

## Current-run files

- `supabase/migrations/20260922115649_device_bound_return_void.sql`
- `scripts/test-device-bound-return-void-postgres.mjs`
- `.github/workflows/trusted-device-enforcement.yml`
- `electron/services/device-credentials.ts`, `electron/main.ts`, `electron/preload.ts`, `electron/types.ts`
- `src/types/electron.d.ts`
- `src/modules/sales/ReturnDialog.tsx` and test
- `src/modules/sales/VoidSaleDialog.tsx` and test
- `src/test/desktop/device-credentials.test.ts`

## Previous verified checkpoint

- Bahrain timestamp: 2026-09-22 13:54 +03.
- Repository: `MuhamedZanabal/ZAIPOS`; default branch `main`.
- Main: `44dd533251acde0de35fe31a8286532857d268ef` (unchanged).
- Active stack: draft PR #76 `fix/device-bound-cash-movement-20260922` → PR #75 `fix/offline-mutation-reconciliation-20260921` → PR #74 `fix/device-offline-runtime-custody-20260921` → PR #72 `fix/device-bound-checkout-20260919`.
- Open PRs are ten: #64, #66, #68, #69, #70, #71, #72, #74, #75, #76. All draft. No merge is authorized.
- Current published code head: `f75983a02d084f1b97b04023bac3c3f6f81fbfc5` (`test(device): route cash contracts through enrolled terminals`).
- Exact-head CI for `f75983a`: all 20 workflows plus unsigned Windows packaging succeeded, including CI #682 / `35717821492` (quality job `106713369307`, windows-package job `106714198852`) and trusted-device run `35717821506` / job `106713369481`. This included the production PostgreSQL migration chain, cash-mutation authority, cash replay, trusted-device cash/checkout denial matrix, 315 Vitest tests, lint, production build and unsigned Windows packaging. This is not signing or installation acceptance.
- PR #76 initial code head `9415da370efe4a4312117481dfef6e9091a0029c` failed quality job `106602351809` and trusted-device job `106602351554`. That SHA is not proof for later heads.
- Parent published documentation head (PR #75): `23f36446b92ed7c47311e33a9e3348786550ea3e`.
- Parent published code head (PR #75): `b4cae4eceea460d41e0e21284b63d0285a81ec6c`.
- Exact-head CI for `85a9383f` (then-current PR #75 docs head): CI #679 / `35677864681`. Historical proof only for that SHA.

## Work completed in this run

PR #76 binds manual cash movements and its exact-head contracts are now green:

- Authenticated execution of credential-less `record_cash_movement_v2` / `cancel_cash_movement_v2` is revoked.
- Device-bound v3 wrappers verify user, tenant, branch, session, enrolled device, credential hash and revocation before replay or effect.
- Electron main brokers cash movement with OS-protected credential custody and narrow IPC. Browser cash UI fails closed without native `window.electron.cashMovement`.
- Exact BHD decimal text, immutable reference recovery and `ZC001` conflict semantics are preserved.
- `f75983a` repaired the `9415da3` CI defects: cash-authority/replay contracts now enroll a manager-approved terminal before any authorized effect; trusted-device till snapshots use scalar subqueries instead of mixing `count(*)` with session totals.

## Local verification

- `npx vitest run`: 61 files, 315 tests passed.
- Focused native cash/device suites: 6 files, 34 tests passed.
- ESLint on the touched Electron/cash/test files: zero errors.
- Exact-head CI #682 quality, trusted-device and unsigned Windows packaging succeeded for `f75983a`.
- Standalone `tsc -p tsconfig.electron.json --noEmit` remains blocked by pre-existing `import.meta.env` and `manager-authorization.ts` typing errors.

## Files modified in this run

Published on PR #76 as `9415da3` then repaired by `f75983a`:

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
- `scripts/test-trusted-device-enforcement-postgres.mjs`
- `scripts/test-cash-mutation-authority-postgres.mjs`
- `scripts/test-cash-replay-postgres.mjs`
- `docs/engineering/ZAIPOS_AUTONOMOUS_HANDOFF.md`

## Hazards and boundaries

- Offline checkout is still disabled. Capture and drain throw until the gate is explicitly enabled in tests; production wiring remains `{ enabled: false }`.
- Never expose lease token, credential, encrypted records or native queue custody to renderer JavaScript.
- Do not merge, force-push, deploy, release, touch production data, or claim signing/hardware/provider acceptance.
- `docs/production-readiness/REMAINING_TASKS.md` has stale opening status and must not be treated as current authority without reconciliation.
- `record_cash_movement_v2` / `cancel_cash_movement_v2` remain the exact-fils primitives but are no longer executable by authenticated clients.
- `9415da3` is not proof for `f75983a`. Pending or historical workflows are never exact-head proof.

## Remaining priority

1. Continue trusted-device enforcement for delivery finance without duplicating stacked PR #72/#74/#75/#76/#77/#78/#79 work. Inventory the authoritative delivery collection RPC and actual renderer/native callers first; preserve existing atomic/idempotent exact-fils behavior.
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

Fetch live main, open PRs #64/#66/#68/#69/#70/#71/#72/#74/#75/#76/#77/#78/#79 and the current PR #79 head. Compare them with this file. CI #690, trusted-device run `35758780011`, supplier-subledger run `35758780093`, and backup/restore run `35758779922` are proof only for `b6f724f1`. Begin the next scoped child by inventorying delivery financial mutations and callers, then reproduce credential-less access before binding the highest-risk operation to native custody. Do not enable offline checkout. Pending or historical workflows are never exact-head proof.

Scheduled hourly automation title: `ZAIPOS Autonomous Engineering` (task `01a0c5ed-9990-7530-adea-231f31a9ee61`, every 1 hour). Scheduled invocations reconstruct continuity from this file and live GitHub state; they do not continue between invocations and may not append to the originating chat.
