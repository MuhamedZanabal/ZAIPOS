# Stocktake / Cycle Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-authoritative, auditable stocktake/cycle-count sessions that reject stale physical counts and finalize through the existing exactly-once inventory reconciliation boundary.

**Architecture:** PostgreSQL owns session lifecycle, opening snapshots, count writes, concurrency checks, finalization and audit evidence. Finalization reuses `reconcile_inventory_levels_v2` rather than adding a second stock-adjustment authority. The React inventory surface only captures operator intent and displays authoritative state.

**Tech Stack:** PostgreSQL/Supabase migrations and RPCs, Node contract scripts, React 19/TypeScript, TanStack Query, Vitest, GitHub Actions, Electron Windows packaging.

**Spec:** `docs/superpowers/specs/2026-09-12-stocktake-cycle-count-design.md`

## Global Constraints
- Bahrain-native ZAIPOS; preserve BHD exact-money and existing transaction invariants.
- No direct authenticated mutation of protected inventory ledgers.
- Stable operation identities are payload-bound and replay-safe.
- Tenant/branch/center scope is enforced server-side.
- Forward-only migration; no migration history rewrite.
- Stock quantities permit at most three decimal places.
- No stale physical count may silently overwrite concurrent inventory activity.

---

### Task 1: RED stocktake database contract

**Files:**
- Create: `scripts/test-stocktake-cycle-count.mjs`
- Create: `scripts/test-stocktake-cycle-count-postgres.mjs`
- Create: `.github/workflows/stocktake-contract.yml`

**Interfaces:**
- Consumes: production migration chain and existing inventory reconciliation RPC.
- Produces: failing CI contract until stocktake tables/RPCs exist.

- [ ] Write the static contract requiring `stocktakes`, `stocktake_items`, lifecycle RPCs, direct-write revocation, stale snapshot comparison, audit markers, and finalization delegation to `reconcile_inventory_levels_v2`.
- [ ] Write the runtime contract that applies the full migration chain and proves lifecycle, replay/mismatch, authorization, stale-session rejection, final stock evidence, and mutation lockdown.
- [ ] Run via a dedicated PostgreSQL-backed GitHub Actions workflow and confirm RED because the stocktake migration does not yet exist.

### Task 2: Authoritative stocktake migration

**Files:**
- Create: `supabase/migrations/20260912060000_stocktake_cycle_count.sql`

**Interfaces:**
- Produces: `start_stocktake_v1(uuid,uuid,uuid,jsonb,text)`, `record_stocktake_count_v1(uuid,uuid,numeric,text)`, `finalize_stocktake_v1(uuid,text)`, `cancel_stocktake_v1(uuid,text)`.
- Reuses: `claim_inventory_operation_v2` for count-write replay and `reconcile_inventory_levels_v2` for final stock effects.

- [ ] Create lifecycle tables, indexes, tenant/branch structural constraints, RLS, and authenticated read grants.
- [ ] Add mutation-protection triggers or grants so authenticated clients cannot write tables directly.
- [ ] Implement session start with deterministic snapshot capture and role/center validation.
- [ ] Implement idempotent count recording with exact quantity validation.
- [ ] Implement finalize with all-items-counted gate, deterministic row locks, quantity + `updated_at` drift detection, reconciliation delegation, finalization replay, and audit evidence.
- [ ] Implement cancellation without inventory effects.
- [ ] Run dedicated static/runtime contract until GREEN.

### Task 3: Client adapter and inventory UI

**Files:**
- Modify: `src/lib/inventory.ts`
- Create: `src/modules/inventory/components/StocktakeDialog.tsx`
- Create: `src/modules/inventory/components/StocktakeDialog.test.tsx`
- Modify: `src/modules/inventory/Inventory.tsx`

**Interfaces:**
- Adapter exposes start/count/finalize/cancel RPC wrappers with stable mutation IDs.
- Dialog receives tenant/branch/centers/products and invalidates stock/movement queries after finalization.

- [ ] Write RED UI/adapter tests proving no client-computed delta, finalization blocked until all counts exist, and stale-session errors are surfaced.
- [ ] Add typed wrappers to `src/lib/inventory.ts`.
- [ ] Build the Stocktake dialog with center selection, count entry, variance display, complete-count gate, cancel/finalize actions, and error states.
- [ ] Wire the Inventory action and query invalidation.
- [ ] Run focused Vitest then full Vitest/lint/build.

### Task 4: Production evidence and integration

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/PRODUCTION_PROGRAM.md`
- Modify: `docs/production-readiness/BURN_DOWN.md`

**Interfaces:**
- CI includes the stocktake runtime gate before broader tests/build.

- [ ] Wire the stocktake contract into general CI while retaining the dedicated workflow.
- [ ] Update evidence docs only after exact-head green proof exists; reconcile already-merged pricing, duplicate merge, catalogue import, and lot/expiry statuses while touching the stale P1 checklist.
- [ ] Verify exact PR head: migration chain, stocktake runtime, inventory regressions, authorization, lint, full tests, build, and Windows package.
- [ ] Merge only with exact-head green gates.
- [ ] Verify post-merge `main` and record evidence.
