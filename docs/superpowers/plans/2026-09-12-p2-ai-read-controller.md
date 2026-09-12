# P2 AI Read Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ZAIPOS AI's P0 no-evidence screen with the first production-safe P2 capability: a server-authorized, branch-scoped, exact-fils reporting evidence controller that the UI can query without granting AI any business-state mutation authority.

**Architecture:** Reuse the verified `get_branch_reporting_snapshot_v1` reporting boundary rather than introducing direct AI table access. Add one read-only `SECURITY DEFINER` RPC that validates branch/time/question input, delegates financial truth to the reporting snapshot, and returns structured evidence metadata with source IDs/dates and exact integer fils. The React AI workspace consumes only this RPC and renders facts/evidence; legacy autonomous AI RPCs remain fully revoked.

**Tech Stack:** PostgreSQL 17 / Supabase migrations, React 18 + TypeScript, Supabase JS, Node contract tests, GitHub Actions.

**Spec:** `docs/AI_AGENT.md`

## Global Constraints

- Bahrain-native BHD remains exact integer fils for authoritative monetary values.
- Authorization and branch/tenant scope are enforced server-side.
- AI cannot execute arbitrary SQL or mutate sales, payments, inventory, prices, refunds, orders, cash, supplier/customer financial state, or permissions.
- Legacy AI RPCs remain revoked for `anon`, `authenticated`, and `service_role`.
- Evidence must expose branch/tenant scope, explicit time range, generation time, source type, and persisted source references where available.
- No fabricated fallback data or simulated operational claims.
- Offline or unavailable-source states fail closed rather than inventing answers.

---

### Task 1: RED production contract

**Files:**
- Create: `scripts/test-ai-read-controller.mjs`
- Create: `.github/workflows/ai-read-controller-contract.yml`
- Modify: `package.json`

**Interfaces:**
- Requires `public.ai_read_reporting_context_v1(uuid,timestamptz,timestamptz,text)`.
- Requires the AI UI to call only the new read controller for live claims.
- Requires legacy autonomous RPC grants to remain revoked.

- [ ] Add a PostgreSQL/static contract asserting the RPC exists, is authenticated-only, rejects cross-tenant/unauthorized branch access, preserves exact-fils reporting values, returns evidence metadata, and leaves legacy write-capable AI RPCs revoked.
- [ ] Add a dedicated PostgreSQL 17 CI workflow that applies the complete production migration chain and preserves failure diagnostics.
- [ ] Run the exact-head workflow and verify it fails because the new RPC/UI behavior does not yet exist.

### Task 2: Server-authoritative read controller

**Files:**
- Create: `supabase/migrations/20260912173000_ai_read_reporting_context.sql`

**Interfaces:**
- Produces `public.ai_read_reporting_context_v1(p_branch_id uuid, p_start_at timestamptz, p_end_at timestamptz, p_question text) returns jsonb`.
- Delegates authoritative financial aggregation to `public.get_branch_reporting_snapshot_v1`.

- [ ] Validate non-empty question, ordered time range, bounded range, authenticated user, and branch authorization.
- [ ] Call the existing deterministic reporting snapshot instead of reading money directly.
- [ ] Return structured `fact`, `evidence`, and `scope` JSON including integer fils, source sale IDs from `recent_sales`, reporting time range, and generation time.
- [ ] Revoke public execution and grant only `authenticated` execution.
- [ ] Run the controller contract and complete migration-chain test until green.

### Task 3: Evidence-backed AI workspace

**Files:**
- Modify: `src/modules/ai-agent/AIAgent.tsx`
- Modify: `src/modules/settings/AiAgentSettings.tsx`
- Modify: `scripts/test-ai-safety.mjs`

**Interfaces:**
- Consumes `ai_read_reporting_context_v1` via Supabase RPC.
- Never invokes legacy `ai_create_digital_order`, `ai_quote_order`, `ai_handoff_to_human`, or arbitrary SQL.

- [ ] Replace the P0 locked disclosure screen with a read-only question form that uses the active branch and an explicit reporting range.
- [ ] Render returned facts separately from evidence/source scope and disclose read-only limitations.
- [ ] Keep all mutation controls absent.
- [ ] Update safety regression assertions so source-backed reads are permitted while fabricated metrics and autonomous tools remain prohibited.
- [ ] Run focused AI safety, migration, Vitest, lint, and production build checks.

### Task 4: Integration and release evidence

**Files:**
- Modify: `docs/AI_AGENT.md`
- Modify: `docs/production-readiness/BURN_DOWN.md`

- [ ] Document the new read-controller authority boundary and evidence contract.
- [ ] Run exact-head dedicated AI contract plus general CI and Windows packaging.
- [ ] Review the PR for privilege expansion, exact-money regressions, fabricated claims, and mutation paths.
- [ ] Merge only on exact-head green evidence, then verify the post-merge `main` workflows before selecting the next P2 gap.
