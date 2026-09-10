# Bahrain Pricing Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe Bahrain supermarket pricing-policy engine that calculates exact selling-price recommendations from historical/current exact-fils cost and applies them only through explicit authorized commands.

**Architecture:** Reuse the canonical product-financial authority introduced by PR #24. Pricing rules are historical effective-dated records with deterministic precedence; preview is read-only; explicit bounded batch apply validates the complete reviewed cost, current-price and policy snapshot before invoking the existing authoritative selling-price command. No policy activation automatically changes a completed or current product price.

**Tech Stack:** PostgreSQL/Supabase migrations and RLS, React + TypeScript + Vite, existing exact BHD money helpers, GitHub Actions, Vitest/Node database contract tests.

**Spec:** `docs/PRODUCTION_PROGRAM.md` P1 Bahrain pricing policy engine requirements plus the approved production continuation directive.

## Global Constraints

- Locale: en-BH.
- Currency: BHD with three decimal places.
- Authoritative money storage: integer fils; no floating-point financial authority.
- Default markup: 33% represented as 3300 basis points.
- Approved retail increment: 25 fils, yielding `.000/.025/.050/.075` endings.
- Policy activation never silently reprices products.
- Price application must preserve PR #24 canonical price history and historical COGS.
- Server-side tenant/branch authorization, idempotency, RLS, direct-write lockdown, and immutable audit evidence are required.

---

### Task 1: Establish RED Pricing Contract

**Files:**
- Test: `scripts/test-bahrain-pricing-policy.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: existing production migration chain and PR #24 product financial RPCs.
- Produces: `npm run test:migrations:bahrain-pricing-policy` as a blocking CI gate.

- [x] Write database contract tests for calculation, rule precedence, authorization, preview, explicit apply, stale-cost rejection, idempotency, audit, RLS, history integration and manual override preservation.
- [x] Wire the test script into `package.json`.
- [x] Add the pricing gate immediately after product-financial-history in CI.
- [x] Open draft PR #25 and capture initial RED CI #264, category-inheritance RED #268, and approval-bypass RED #269.

### Task 2: Implement Server-Authoritative Pricing Engine

**Files:**
- Create: `supabase/migrations/20260910040000_bahrain_pricing_policy.sql`

**Interfaces:**
- Produces: `calculate_bahrain_retail_price_v1(bigint,integer,bigint,text) -> jsonb`.
- Produces: `set_pricing_policy_rule_v1(uuid,uuid,uuid,uuid,integer,bigint,text,text,text) -> uuid`.
- Produces: `deactivate_pricing_policy_rule_v1(uuid,uuid,text,text) -> uuid`.
- Produces: `preview_product_pricing_v1(uuid,uuid,uuid,sales_channel) -> jsonb`.
- Produces: `apply_product_pricing_policy_v1(uuid,uuid,uuid,sales_channel,bigint,text,text) -> jsonb`.
- Consumes: `set_product_selling_price_v1` for canonical selling-price mutation/history.

- [x] Create effective-dated `pricing_policy_rules` with structural tenant/branch/category/product foreign keys and deterministic valid-scope checks.
- [x] Create `pricing_policy_operations` with bounded stable operation IDs, request hashes, stored results and replay protection.
- [x] Enable RLS and grant read-only rule visibility by legitimate tenant/branch role; deny authenticated direct mutation of rules and operations.
- [x] Implement exact rational markup calculation and deterministic 25-fils nearest-half-up/ceil rounding without floating-point authority.
- [x] Implement deterministic precedence: product+branch → product → category+branch → category → branch → tenant → system default.
- [x] Enforce tenant-wide roles for tenant-global rule mutation and branch roles only for their branch-local rule mutation.
- [x] Implement effective-dated activation/deactivation preserving historical rule and before/after audit evidence.
- [x] Implement bounded non-mutating preview returning exact calculation, cost/price source IDs, rule scope, actor, and authoritative timestamp.
- [x] Implement atomic reviewed-batch apply with full stale-snapshot validation, idempotency, canonical price history and immutable audit.
- [x] Ensure manual price override remains authoritative until another explicit policy apply.
- [x] Run focused pricing database gates, including genuine overlapping PostgreSQL sessions.

### Task 3: Add Manager Pricing Operations UI

**Files:**
- Create: `src/lib/pricingPolicyCommands.ts`
- Create: `src/modules/pricing-policy/PricingPolicy.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/AppSidebar.tsx`
- Test: `src/modules/pricing-policy/PricingPolicy.test.tsx`

**Interfaces:**
- Consumes: pricing preview/rule/apply RPCs.
- Produces: manager-facing policy configuration, explainable preview and explicit Apply Repricing controls.

- [x] Add typed client wrappers that retain stable operation IDs for uncertain-result retries and never write price tables directly.
- [x] Add owner/admin/manager pricing route and navigation.
- [x] Render default/branch/category/product rule controls with exact markup/increment/mode display.
- [x] Render explainable preview with cost, markup, raw target, rounding adjustment, final price, difference, source and applied rule.
- [x] Require explicit user action for every pricing mutation/apply and surface stale/server authorization failures.
- [x] Add component/client tests proving preview does not mutate and apply uses the authoritative reviewed-batch RPC.

### Task 4: Reconcile Existing Production Evidence

**Files:**
- Modify: `docs/PRODUCTION_PROGRAM.md`
- Modify: `docs/production-readiness/BURN_DOWN.md`

- [x] Mark multiple barcodes/collision handling VERIFIED COMPLETE from PR #23 evidence.
- [x] Mark product price history and cost history/historical COGS VERIFIED COMPLETE from PR #24 evidence.
- [x] Record exact PR #23/#24 branch, merge and post-merge CI evidence.
- [x] Keep Bahrain pricing policy unchecked until its own merge and post-merge verification complete.

### Task 5: Exact-Head Integration and Merge

- [ ] Run/observe the complete exact-head CI, requiring `quality` and `windows-package` green.
- [ ] Inspect the complete PR diff and review comments/threads; fix any real defects RED → GREEN on the same branch.
- [ ] Mark PR ready only on the reviewed green head.
- [ ] Merge only the exact reviewed head SHA.
- [ ] Capture merge SHA and require post-merge `main` `quality` + `windows-package` green.
- [ ] Only after post-merge green classify Bahrain pricing policy VERIFIED COMPLETE.
- [ ] Begin duplicate-product review/merge immediately, carrying the pricing evidence reconciliation forward in that implementation PR.
