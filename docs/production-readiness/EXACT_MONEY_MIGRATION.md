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

## Stage B — inventory and classify every remaining money field

Add sidecars for purchases, supplier accounting, returns/refunds, digital orders, delivery fees, discounts, customer credit and loyalty liability. Polymorphic values such as percentage-or-fixed discounts must be split by meaning rather than converted blindly.

## Stage C — dual-read validation

- Read both representations in server commands and diagnostics.
- Reject parity drift.
- Run the parity view against a production-shaped restored database.
- Record row counts and zero-mismatch evidence.

## Stage D — fils-native commands

Introduce versioned server commands whose inputs and internal arithmetic are integer fils. Checkout must validate server-resolved prices, exact payment allocations, tenant/branch relationships and idempotency in one transaction.

## Stage E — authoritative cutover

- Switch transactional reads and reports to fils.
- Reverse the compatibility bridge so any required legacy decimal output is derived from fils.
- Keep old columns for a defined observation period.

## Stage F — retirement

Only after restore testing, parity evidence and an approved rollback window may obsolete decimal fields be removed. Historical migrations remain unchanged.

## Required verification before Stage D

- Clean database migration run.
- Upgrade from the supported production baseline.
- Zero rows in `money_fils_parity_violations`.
- Boundary fixtures for `0.001`, `0.025`, `0.250`, `1.000`, negative adjustments and maximum supported values.
- Checkout, refund, cash close, report and offline-replay integration tests.
