# ZAIPOS operational alerts production boundary

## Purpose

Operational alerts surface deterministic branch conditions from persisted PostgreSQL state. They are advisory and read-only. They do not execute sales, inventory, pricing, supplier, customer, cash, refund, order, permission or other business-state mutations.

## Authoritative controller

`public.get_branch_operational_alerts_v1(p_branch_id uuid, p_as_of_date date)` is the server-authoritative read boundary.

The controller:

- requires an authenticated user;
- reuses `get_branch_reporting_snapshot_v1` for tenant/branch authorization instead of trusting client tenant identifiers;
- grants execution to `authenticated` only and explicitly revokes `PUBLIC`, `anon` and `service_role` execution;
- returns `mode = read_only` and explicit limitations;
- preserves Bahrain money semantics by declaring BHD integer fils as the evidence money unit even though the current alert classes contain no monetary calculation;
- emits persisted source identifiers for every alert;
- performs no business-state mutation.

## Production alert classes

### Out of stock

- Source: branch `inventory_stocks` aggregated per active product.
- Condition: authoritative branch quantity is `<= 0`.
- Severity: `critical`.
- Provenance: product ID plus persisted quantity/minimum-stock evidence.

### Low stock

- Source: branch `inventory_stocks` aggregated per active product plus the product's persisted `min_stock` threshold.
- Condition: quantity is positive, `min_stock > 0`, and quantity is below `min_stock`.
- Severity: `warning`.
- Provenance: product ID plus persisted quantity/minimum-stock evidence.

### Expired lot

- Source: `inventory_lots` with remaining quantity.
- Condition: `expiry_date < p_as_of_date`.
- Severity: `critical`.
- Provenance: lot ID, product ID, batch, expiry date and remaining quantity.

### Expiring lot

- Source: `inventory_lots` with remaining quantity.
- Condition: expiry date is on or before `p_as_of_date + 30 days` and is not already classified as expired.
- Severity: `warning`.
- Provenance: lot ID, product ID, batch, expiry date, remaining quantity and days to expiry.

## User-facing behavior

The ZAIPOS AI operational surface loads this controller when the selected branch changes and exposes a manual refresh action. It does not create an uncontrolled polling loop. Failures are fail-closed: the UI displays the source error and does not invent fallback alerts.

Each rendered alert includes severity, source type, source ID and a compact persisted-evidence summary. The alert panel has no execute/apply/mutate action.

## Verification

The dedicated `Operational Alerts Contract` workflow proves:

1. the production migration chain applies before alert tests;
2. anonymous and service-role execution are denied while authenticated execution is explicitly granted;
3. out-of-stock, low-stock, expired-lot and <=30-day expiry behavior is deterministic;
4. every alert remains branch-scoped and source-backed;
5. cross-tenant branch access is rejected;
6. the controller advertises no business-state mutation authority;
7. the user-facing surface invokes the authoritative RPC, renders provenance and severity, and has no uncontrolled polling loop.

The general CI remains the regression authority for Bahrain localization, exact money, checkout, transaction lifecycle, inventory, authorization/audit, lint, Vitest, production build and Windows validation packaging.

## Intentionally excluded

This slice does not add autonomous remediation, push notifications, WhatsApp delivery, competitor intelligence, inferred/fabricated alerts, dynamic ML thresholds, or background mutation agents. Those require separate production contracts and authority boundaries.
