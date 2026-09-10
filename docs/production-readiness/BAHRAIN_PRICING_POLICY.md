# Bahrain pricing policy

Status: implementation on PR #25; completion requires reviewed-head CI, merge,
and successful push-triggered main CI. This document is not a production sign-off.

## Operator workflow

Open **Catalog → Pricing policies** as an owner, administrator, or manager.
Select tenant base prices or an authorized branch. Select a channel only when
you intend to change that channel's selling price.

1. Optionally configure a scope default, category, or product rule. Enter markup,
   rounding mode, and a reason. **Activate rule** preserves previous rule history
   and changes recommendations only. **Deactivate** restores inherited rules.
2. Find and select up to 100 active products. **Preview selected prices** reads
   their current costs and selling prices. Review source cost, markup, raw target,
   rounding adjustment, final price, and responsible rule.
3. Enter a repricing reason and choose **Apply reviewed prices**. This explicitly
   replaces the displayed current/manual prices in the selected scope.

The full batch succeeds or fails together. A stale-preview error means a cost,
selling-price version, category, or applicable rule changed: preview and review
again. For a connection error, retry the unchanged request in the current screen;
it retains its operation ID. Do not treat lack of response as proof of failure.
After a page restart, reload prices and inspect the audit before making another
pricing decision. Pricing changes require an online server response and are not
queued as offline checkout operations.

Branch managers can manage only explicitly assigned branches. Tenant base
changes require a tenant-wide owner/admin/manager membership. Frontend controls
are convenience; database commands enforce the same policy independently.

## Exact calculation

All source and committed money is integer fils. Markup is integer basis points:
33% = 3300. Let `N = cost_fils × (10000 + markup_basis_points)`.
The raw target is the exact fraction `N / 10000` fils.

| Mode | Final integer fils |
| --- | --- |
| nearest_half_up (default) | `floor((N + 125000) / 250000) × 25` |
| ceil | `ceil(N / 250000) × 25` |

Every result is a multiple of 25 fils. For each 100-fils block the endings are
000, 025, 050, and 075. Ties round upward. At cost 1000 fils with 33% markup,
raw target 1330 fils becomes 1325 fils (nearest) or 1350 fils (ceil).
At cost 1250 fils, raw 1662.5 fils becomes 1675 fils in both modes.

The pure calculation helper defines zero cost as zero, but product preview/apply
rejects nonpositive cost because a supermarket zero normally means missing cost.
Negative/null costs, invalid markup/mode/increment, and BIGINT overflow fail.
Markup accepts 0–10000%, with at most two decimal places in the UI. PostgreSQL
uses exact numeric intermediates and checks the final BIGINT range. API money
and raw numerators are decimal strings, preserving values above JavaScript's
safe integer range. The UI formats final BHD with three decimal places and the
raw calculation/adjustment with seven, using BigInt only.

## Scope and history

Precedence is product+branch → product → category+branch → category → branch
default → tenant default → built-in 33% nearest-half-up. With no branch selected,
only product → category → tenant → built-in rules apply. Rules are not specific
to a sales channel; the selected channel determines the target selling-price
history. Branch-specific policy exists only after explicit configuration.

Cost comes from the selected branch's current cost-history event when present,
otherwise the product's current base cost. Previews contain cost and selling-price
history IDs, rule ID, scope, category, and every calculation input/output. A cost
receipt may change the next recommendation but never commits a selling price.
The engine does not add a background candidate queue.

The batch command compares the complete reviewed snapshot with fresh server
evidence under locks. Manual price changes, cost versions, category changes, and
rule replacement invalidate a stale approval. Completed sales, VAT, sale-item
prices, and COGS are never rewritten. The existing limitation that pre-migration
COGS may be labelled `legacy_current_cost_at_migration` is unchanged.

## Database and recovery

Migrations 20260910040000 and 20260910040100 define rule/operation ledgers and
replay identity. Migration 20260910040200 makes cost-only apply private and
exposes bounded `preview_pricing_batch_v1` / `apply_pricing_batch_v1` commands.
No pre-existing migration is rewritten by this programme branch.

Rules use tenant-composite foreign keys, unique active scope indexes, RLS, and
no authenticated direct writes. Internal claim/completion and cost-only apply
functions are not executable by application roles. Repricing uses canonical
`set_product_selling_price_v1`, preserving financial history and authorization.

Rule mutation and batch application share a tenant advisory transaction lock.
Batches lock products in UUID order, coordinating with canonical financial
commands and preventing reversed-selection deadlocks. Replay identity includes
actor, scope, full approved payload, reason, and operation ID. Same-operation
concurrency returns the stored result once; conflicting changed-price approvals
reject as stale. A no-op price application may retain the existing price event.

Audit records include actor, tenant, branch/channel, operation, reason, reviewed
before/after calculations, rule and source-version IDs, and execution time.
Rollback is a new reviewed/manual price command with a reason, not deletion of
historical events. Earlier source prices remain available in `product_prices`.

## Verification

- CI #268 reproduced missing category inheritance; CI #269 reproduced direct
  cost-only approval bypass before its execute privilege was revoked.
- The pricing SQL gate checks 2006 rounding vectors, invalid/overflow values,
  manager/cashier/cross-tenant/branch authorization, stale cost/policy/manual
  changes, batch rollback, direct-write lockdown, audit, and historical sales.
- Concurrency uses independent PostgreSQL sessions held at a shared start
  barrier. The gate observes both sessions waiting before releasing them.
- Client/component tests cover exact BHD display, markup parsing, read-only
  preview, explicit approval, stable retry identity, and surfaced failures.
- Full production migrations run both clean-install and supported Bahrain
  upgrade fixtures before the pricing gate; existing financial preservation,
  checkout, inventory, refund, offline, POS/hardware, and release gates remain.

Final SHA and post-merge evidence belong in `PRODUCTION_PROGRAM.md` and
`BURN_DOWN.md` after successful integration.
