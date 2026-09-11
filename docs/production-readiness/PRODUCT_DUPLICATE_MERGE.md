# Product duplicate merge

Status: implementation on PR #26; completion requires exact-head CI, merge, and successful post-merge verification on `main`. This document is not a production sign-off.

## Purpose and authority boundary

The duplicate-product workflow consolidates current mutable catalogue identity without rewriting historical financial or operational evidence. It is intentionally conservative: the source product is retained as an inactive alias, not deleted.

`preview_product_merge_v1` and `merge_duplicate_product_v1` require tenant-wide manager authority. Branch-only managers, cashiers, cross-tenant users, anonymous users, and direct table writers are not authoritative merge paths. Server/database checks remain authoritative even if a future UI hides or disables the action.

## Reference semantics

Every foreign key from the fully migrated schema to `public.products` is classified by exact schema/table/constraint/column identity. Table-level allowlists are prohibited because several tables contain multiple product roles with different semantics.

The four classifications are:

- `HISTORICAL_RETAIN`: preserve the original product ID in immutable/historical evidence.
- `TRANSFER_TO_CANONICAL`: move current mutable state to the canonical product under the authoritative merge transaction.
- `BLOCK_WHILE_ACTIVE`: fail closed until the operator explicitly reconciles the live relationship.
- `STATE_DEPENDENT`: allow the historical/settled relationship, but block while the related workflow is live.

Current transferable state is limited to stock and active barcode identity. Historical sale items, returns, voids, purchase-order items, inventory movements, production consumption, pricing history, barcode-operation/conflict evidence, pricing-policy operations, and merge ledgers retain their original product references.

State-dependent blockers include held carts, active production orders, and pending/approved price overrides. Live catalogue blockers include modifier groups, product-specific pricing policy rules, complementary-product relationships in either role, and product-component/BOM relationships in either role.

## Operator workflow

1. Select the suspected duplicate source and intended canonical product within the same tenant.
2. Run preview. Do not attempt the merge when `can_merge` is false.
3. Resolve every returned blocker explicitly in its owning workflow. Do not bypass blockers by direct SQL updates or by temporarily disabling constraints.
4. Preview again after reconciliation.
5. Execute merge with a stable operation ID and reason.
6. If the client loses the response, retry the unchanged request with the same operation ID. Do not infer failure from a timeout.
7. Confirm the source product is inactive, barcodes resolve to the canonical target, stock transferred exactly, and audit/operation evidence is present.

## Transaction and idempotency guarantees

The authoritative merge locks source and canonical products, validates tenant/product state, calls the server-side preview gate, transfers inventory with stable inventory-operation identities, transfers barcodes, writes the alias ledger, inactivates the source, writes audit evidence, and completes the merge operation in one database transaction.

Operation identity is payload-bound. Replaying the same operation ID with the same merge intent reconstructs/returns the stored result; reusing it for different source, canonical target, tenant, actor, or reason is rejected. A failed transaction does not leave a partially merged catalogue.

The source product is never destructively deleted. `resolve_canonical_product_id_v1` follows the alias to the canonical product while historical rows remain attached to the original source ID.

## Fail-closed live-reference hardening

Migration `20260912010000_product_duplicate_merge_reference_safety.sql` wraps the original preview implementation. The private base retains existing state-dependent blockers; the public wrapper adds exact live catalogue blockers. Application roles cannot execute the private base directly.

This split is deliberate: it preserves previously tested authorization/state behavior while extending the fail-closed policy without rewriting the earlier migration. The CI reference audit reads both authoritative preview layers and fails on any unclassified product FK or any classified blocker/transfer table absent from the relevant server-side command definition.

## Recovery and rollback

There is no destructive rollback that rewrites historical product references. If a business decision later changes, create/restore the required live catalogue relationships explicitly and, where appropriate, perform another reviewed merge in the correct direction only after validating its own blockers. Never delete merge, inventory, barcode, financial, sale, return, void, or audit history to simulate rollback.

If a merge is interrupted before commit, PostgreSQL transaction atomicity leaves the pre-merge state intact. If a completed merge produced an operationally wrong business choice, preserve the completed evidence and correct forward with explicit catalogue commands rather than editing historical ledgers.

## Verification contract

The product-merge gate verifies tenant-global authorization, cross-tenant rejection, branch-manager/cashier rejection, source/canonical validity, stable replay identity, barcode transfer, exact stock transfer, historical reference preservation, live-workflow blockers, source alias/inactivation, audit evidence, and transaction rollback behavior.

The exact-reference audit enumerates every migrated FK to `public.products`, requires a policy for each exact identity, rejects stale policy entries, and confirms all `BLOCK_WHILE_ACTIVE`/`STATE_DEPENDENT` tables participate in authoritative preview logic while all `TRANSFER_TO_CANONICAL` tables participate in the authoritative merge.

Final SHA and post-merge CI evidence belong in `PRODUCTION_PROGRAM.md` and `BURN_DOWN.md` after successful integration.
