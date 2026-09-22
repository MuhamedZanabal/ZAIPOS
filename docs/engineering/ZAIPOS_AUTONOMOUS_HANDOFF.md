# ZAIPOS autonomous engineering handoff

This is the durable recovery checkpoint for scheduled ZAIPOS production-completion runs. Verify every identifier against live GitHub before acting; later exact-head evidence supersedes this file.

## Current checkpoint — PR #81 (2026-09-22)

- Repo: `MuhamedZanabal/ZAIPOS`; base PR #80 draft head `ba236f9ef4d05357bcacad968ea023feadd319b9`.
- New draft PR #81: `fix/device-bound-table-checkout-20260922` stacked directly on PR #80; code head `9c60ae20fdf2b7c26c52dfa0516c4e1ce5421dc4`.
- Exact-head CI #695, run `35770591058`, completed successfully (quality and unsigned Windows packaging). This is evidence for **only the renderer legacy-queue cutover** and cannot be used to claim native restaurant checkout or PostgreSQL device enforcement is complete.
- Three files changed on PR #81 at code head: `src/lib/syncQueue.ts` rejects new `CHECKOUT_TABLE_ORDER` legacy queue inserts alongside prior sale types; `src/hooks/useSyncEngine.ts` refuses to replay existing table-checkout items through credential-less `checkout_table_order` (retained for operator review); `src/lib/checkoutCutover.test.ts` asserts rejection.
- The live `src/modules/tables/TableOrder.tsx` interactive path still uses renderer `supabase.rpc('checkout_table_order', ...)` via `useOfflineMutation` and is **not secure**. The browser guard prevents new writes through this hook, so existing table-checkout UI now fails closed at that hook, but authenticated direct RPC access remains unrevoked at the server. PR #81 must remain draft/unmerged and is **NOT A COMPLETE SECURITY FIX**.
- `src/integrations/supabase/types.ts` exposes legacy `checkout_table_order` with two arguments, while current TableOrder sends payment, tip, discount and coupon keys; types are historical and must not be treated as authoritative SQL signatures. The actual latest `pg_proc` signatures, privilege ACL, SQL body, exact-money and replay behavior must be read before writing a wrapper or revocation migration. Source browser does not index this stacked branch; local Git clone was inaccessible due DNS (`Could not resolve host: github.com`), so this inspection gate remains open.
- No server migration, credential brokerage, IPC, full restaurant checkout or PostgreSQL acceptance tests have been implemented in PR #81. No merge, deployment, release, force push or production data operation occurred.

### Immediate next executable actions

1. Locate the actual `checkout_table_order` CREATE/REPLACE FUNCTION across source migration history (not generated TypeScript), including overloads, `pg_get_functiondef`, `pg_get_function_identity_arguments`, grants and dependencies; if needed obtain a disposable PostgreSQL read of the fully migrated schema.
2. Reproduce credential-less authenticated execution of the exact function signature and the rejected renderer queue with explicit red tests and zero-effect assertions.
3. Add a device-bound wrapper with terminal credential, tenant/branch/order and cashier/waiter policy enforced before replay; revoke all authenticated legacy overloads without blocking internal definer delegation. Preserve exact-fils, stable idempotency IDs and atomic financial effects.
4. Add secure Electron main-process credential brokerage, narrow preload IPC and renderer-only native path; disable financial offline fallback and preserve retry identity if responses are lost.
5. Run negative/positive PostgreSQL tests (missing, copied, wrong branch, revoked device, waiter/cashier roles, exact one-fils, replay, concurrency and rejected zero effects), TypeScript, Vitest, lint, migration chain and build; collect exact-head CI and update PR #81 once verified.
6. Continue financial RPC/authorization census and offline recovery/security-stack integration; preserve external signing/hardware/DR/provider/regulatory gates.

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
