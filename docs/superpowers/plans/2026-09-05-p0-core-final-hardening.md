# P0 Transaction Core Final Hardening Plan

## Goal

Close the remaining evidence-backed P0 transaction-core production gates in one coherent PR, then verify the exact merge on `main`. Do not split evidence into a second PR.

## Task 1 — Production-shaped migration chain

Add a CI harness that executes the complete ordered migration chain against a fresh PostgreSQL instance and also verifies a supported pre-P0 baseline upgraded through all current P0 migrations. Preserve representative tenant, branch, sale, payment, stock, and cash data across the upgrade. RED first; fix only real migration incompatibilities.

## Task 2 — True checkout concurrency

Use independent PostgreSQL connections to race two authorized checkouts against one remaining unit of stock. Assert exactly one financial sale/stock decrement can commit when negative stock is disabled. Separately race identical operation IDs and assert one durable sale/effect. Do not add locking unless the RED test proves the existing transaction/upsert semantics are insufficient.

## Task 3 — POS E2E and hardware failure invariants

Add an integration-level POS orchestration test covering scan/add → payment allocation → server checkout → committed receipt model → stock refresh. Assert printer failure cannot trigger another checkout, and cash-drawer failure cannot invalidate or retry a committed sale. Reuse Vitest/Testing Library; do not add a new browser test framework for this gate.

## Task 4 — Transaction authorization, tenant/branch consistency, and audit

Build one executable matrix over checkout, return/refund, void, inventory commands, and cash close. Cover permitted roles, denied roles, wrong tenant, wrong branch/session, immutable/direct-ledger restrictions, and required audit evidence. Add forward constraints/hardening only where the matrix proves a gap.

## Task 5 — Combined CI, documentation, review, merge

Wire all new gates into the existing CI before lint/tests/build. Update `PRODUCTION_PROGRAM.md`, `TRANSACTION_CORE.md`, and the production-readiness burn-down only for gates actually green on the final branch head. Review the complete PR diff, mark ready, merge pinned to the verified head SHA, then require a green push-triggered `main` CI before declaring the programme complete.

## Completion rule

No task is complete from implementation alone. Required evidence is RED where applicable, final branch CI green on the exact reviewed head, verified merge, and post-merge `main` CI green.