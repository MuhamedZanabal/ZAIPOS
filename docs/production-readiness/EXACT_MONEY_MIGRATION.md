# Exact money migration

## Objective

Move all authoritative BHD transactional decisions to integer fils without an irreversible big-bang conversion.

## Stage A — sidecars and parity bridge

Migration: `20260904221500_exact_money_stage_a.sql`.

- Add `BIGINT` fils columns to product pricing, channel/branch pricing, sale, payment and cash-session core tables.
- Backfill with `round(existing_numeric * 1000)`.
- Synchronize fils from legacy decimal writes while existing application code remains active.
- Enforce per-row parity constraints.
- Restrict the parity-diagnostic view to the service role.
- Preserve all legacy columns and RPC signatures.

Rollback before application cutover: drop the Stage A triggers, constraints, view, columns and conversion functions. No legacy value is deleted in this stage.

## Stage B — three-decimal compatibility precision

Migration: `20260905024000_exact_money_stage_b_precision.sql`.

The inherited schema used two-decimal `NUMERIC` columns for many monetary values. That is not lossless for Bahrain values such as BHD 0.025 or BHD 1.234: PostgreSQL rounds the compatibility value before the Stage A trigger can derive fils.

Stage B therefore:

- widens existing monetary compatibility columns to `NUMERIC(18,3)` when their precision/scale is narrower;
- performs only lossless widening of existing values;
- covers the current product, sale, payment, cash, table-order, digital-order, purchase, expense and return money surfaces when those columns exist;
- temporarily drops the Stage A parity view because PostgreSQL blocks type changes while a dependent view exists;
- recreates the parity view in the same transaction;
- restores service-role-only diagnostic access;
- preserves all Stage A sidecars, triggers, parity constraints and public RPC signatures.

This stage does **not** make decimal columns authoritative long-term and does not reconstruct precision that may already have been rounded by historical two-decimal storage. It makes the compatibility bridge lossless for new three-decimal BHD writes while the fils-native command cutover is implemented.

## Stage C — inventory and classify remaining money fields

Add integer-fils sidecars, or a domain-specific exact representation, for remaining purchases, supplier accounting, refunds, delivery fees, customer credit, loyalty financial liability and any other monetary columns not covered by Stage A. Polymorphic values such as percentage-or-fixed discounts must be split by meaning rather than converted blindly.

## Stage D — dual-read validation

- Read both representations in server commands and diagnostics.
- Reject parity drift.
- Run the parity view against a production-shaped restored database.
- Record row counts and zero-mismatch evidence.

## Stage E — fils-native commands

Introduce versioned server commands whose inputs and internal arithmetic are integer fils. Checkout must validate server-resolved prices, exact payment allocations, tenant/branch relationships and idempotency in one transaction.

## Stage F — authoritative cutover

- Switch transactional reads and reports to fils.
- Reverse the compatibility bridge so any required legacy decimal output is derived from fils.
- Keep old columns for a defined observation period.

## Stage G — retirement

Only after restore testing, parity evidence and an approved rollback window may obsolete decimal fields be removed. Historical migrations remain unchanged.

## Required verification before fils-native checkout becomes authoritative

- Clean database migration run.
- Upgrade from the supported production baseline.
- Zero rows in `money_fils_parity_violations`.
- Boundary fixtures for `0.001`, `0.025`, `0.250`, `1.000`, negative adjustments and maximum supported values.
- Checkout, refund, cash close, report and offline-replay integration tests.
