# ZAIPOS Stocktake / Cycle Count Design

## Status
Approved production-programme P1 scope, implemented from `main` baseline `45863ee90e5d67a173fb5aa45bc35ac0c45ec765`.

## Goal
Provide auditable physical stocktake/cycle-count sessions without allowing a stale count to overwrite inventory movement that occurred after counting began.

## Authority model
- PostgreSQL is authoritative for stocktake lifecycle and final stock effects.
- Clients may create a count session, record physical counts, cancel it, and request finalization only through SECURITY DEFINER RPCs.
- `inventory_stocks` and `inventory_movements` remain protected ledgers. No new direct authenticated mutation grant is introduced.
- Final stock adjustment reuses `reconcile_inventory_levels_v2`, preserving the existing `inventory_operations` exactly-once boundary and signed adjustment evidence.

## Data model
### `stocktakes`
Immutable identity/scope plus lifecycle fields: tenant, branch, inventory center, status (`open`, `finalized`, `cancelled`), reason, creator/finalizer/canceller, timestamps, finalization mutation ID, and resulting inventory operation ID.

### `stocktake_items`
One row per in-scope product. Each row stores the opening snapshot (`expected_quantity`, `expected_stock_updated_at`), physical `counted_quantity`, counter identity/time, and deterministic ordinal. The opening snapshot is evidence and is never rewritten after session creation.

## Lifecycle
1. `start_stocktake_v1` validates branch/center/role, locks the selected current stock rows in deterministic product order, and snapshots either an explicit product set or all active tenant products. Empty scope is rejected.
2. `record_stocktake_count_v1` writes one non-negative quantity (max 3 decimals) for an in-scope active product while the session is open. The client supplies a stable mutation ID; replay returns the same result and payload-conflicting reuse is rejected through `inventory_operations`.
3. `finalize_stocktake_v1` locks the session and all scoped current stock rows. Every scoped item must be counted. The function compares both current quantity and stock `updated_at` with the opening snapshot. Any intervening inventory activity makes the session stale and finalization fails closed; the operator must recount in a new session rather than overwrite concurrent stock activity.
4. If the snapshot is still current, finalization calls `reconcile_inventory_levels_v2` once with authoritative physical targets, using the supplied finalization mutation ID. The transaction then records the resulting inventory operation and marks the stocktake finalized.
5. Exact replay of the same finalization mutation returns the original inventory operation. A different mutation ID against an already-finalized session is rejected.
6. `cancel_stocktake_v1` closes an open session without stock effects. Finalized sessions cannot be cancelled.

## Authorization and isolation
- Start/count/finalize/cancel: owner, admin, manager, inventory roles within the exact tenant/branch.
- Tenant/branch/center relationships are validated at the server boundary.
- RLS allows scoped reads to authorized operational roles; direct authenticated INSERT/UPDATE/DELETE is revoked.
- Cross-tenant and cross-branch access fails closed.

## Concurrency and failure semantics
- Opening and finalization lock stock rows in product-ID order to avoid inconsistent snapshots and reduce deadlock risk.
- A count never stores or applies a client-computed delta.
- Concurrent movement after session start is detected even when net quantity returns to the same value, because the stock-row timestamp is part of the snapshot contract.
- Finalization is atomic: either all required adjustments and lifecycle/audit evidence commit, or none do.
- Response-loss replay is safe through stored finalization identity and the existing inventory operation ledger.

## Audit evidence
Create audit events for session started, item counted, session finalized, and session cancelled. Finalization audit metadata includes center, counted item count, mutation ID, and resulting inventory operation ID.

## UI
Add a Stocktake action under Inventory. A focused dialog/screen selects an inventory center, starts a session, shows expected quantities, accepts physical counts, highlights variances, blocks finalization until all scoped items are counted, surfaces stale-session failure clearly, and refreshes stocks/movements after successful finalization. It does not calculate or post stock deltas itself.

## Verification contract
- Static migration contract for tables, RPCs, revocations, stale-snapshot checks, exact quantity validation, audit markers, and delegation to `reconcile_inventory_levels_v2`.
- Runtime PostgreSQL contract proving authorization, tenant/branch isolation, snapshot capture, count replay/mismatch, incomplete-count rejection, stale-count rejection after concurrent movement, atomic adjustment evidence, finalization replay, and direct-mutation lockdown.
- Full production migration chain, existing inventory regression suite, TypeScript/lint/Vitest/build, and Windows package must stay green before merge.
