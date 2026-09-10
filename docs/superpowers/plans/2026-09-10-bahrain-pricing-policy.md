# Bahrain Pricing Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe Bahrain supermarket pricing-policy engine that calculates exact selling-price recommendations from historical/current exact-fils cost and applies them only through explicit authorized commands.

**Architecture:** Reuse the canonical product-financial authority introduced by PR #24. Pricing rules are historical effective-dated records with deterministic precedence; preview is read-only; explicit apply validates the cost snapshot and invokes the existing authoritative selling-price command so price history remains canonical. No policy activation automatically changes a completed or current product price.

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
- [ ] Open a draft PR and capture expected RED exact-head CI.

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

- [ ] Create effective-dated `pricing_policy_rules` with structural tenant/branch/category/product foreign keys and deterministic valid-scope checks.
- [ ] Create `pricing_policy_operations` with stable operation IDs, request hashes, stored results and replay protection.
- [ ] Enable RLS and grant read-only rule visibility by legitimate tenant/branch role; deny authenticated direct mutation of rules and operations.
- [ ] Implement exact rational markup calculation and deterministic 25-fils nearest-half-up/ceil rounding without floating-point authority.
- [ ] Implement deterministic precedence: product+branch → product → category+branch when supported → category → branch → tenant → system default.
- [ ] Enforce tenant-wide roles for tenant-global rule mutation and branch roles only for their branch-local rule mutation.
- [ ] Implement effective-dated activation/deactivation preserving historical rule evidence.
- [ ] Implement non-mutating preview returning cost, markup, raw numerator/denominator, rounded price, rule ID/scope and current price context.
- [ ] Implement explicit apply with fresh-cost equality check, separate idempotency ledger, canonical price-history command invocation and immutable audit event.
- [ ] Ensure manual price override remains authoritative until another explicit policy apply.
- [ ] Run the focused pricing database gate and correct only proven failures.

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

- [ ] Add typed client wrappers that generate stable operation IDs and never write price tables directly.
- [ ] Add owner/admin/manager pricing route and navigation.
- [ ] Render default/branch/category/product rule controls with exact markup/increment/mode display.
- [ ] Render explainable repricing preview with cost, markup, raw calculation, rounded price, applied rule and price difference.
- [ ] Require explicit user action for each pricing mutation/apply and surface stale-cost/server authorization failures.
- [ ] Add component/client regression tests proving preview does not mutate and apply goes through the authoritative RPC.

### Task 4: Reconcile Existing Production Evidence

**Files:**
- Modify: `docs/PRODUCTION_PROGRAM.md`
- Modify: `docs/production-readiness/BURN_DOWN.md`

- [ ] Mark multiple barcodes/collision handling VERIFIED COMPLETE from PR #23 evidence.
- [ ] Mark product price history and cost history/historical COGS VERIFIED COMPLETE from PR #24 evidence.
- [ ] Record exact PR #23/#24 branch, merge and post-merge CI evidence.
- [ ] Keep Bahrain pricing policy unchecked until its own merge and post-merge verification complete.

### Task 5: Exact-Head Integration and Merge

- [ ] Run/observe the complete exact-head CI, requiring `quality` and `windows-package` green.
- [ ] Inspect the complete PR diff and review comments/threads; fix any real defects RED → GREEN on the same branch.
- [ ] Mark PR ready only on the reviewed green head.
- [ ] Merge only the exact reviewed head SHA.
- [ ] Capture merge SHA and require post-merge `main` `quality` + `windows-package` green.
- [ ] Only after post-merge green classify Bahrain pricing policy VERIFIED COMPLETE.
- [ ] Begin duplicate-product review/merge immediately, carrying the pricing evidence reconciliation forward in that implementation PR.
