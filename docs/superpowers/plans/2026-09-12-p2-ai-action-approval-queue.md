# P2 AI Action Approval Queue

## Goal

Add the first safe AI action-control-plane primitive without enabling autonomous execution: ZAIPOS AI may create a tenant/branch-scoped pending action request backed by evidence; only an authorized manager may approve or reject it; every transition is immutable/audited; approval itself performs no business-state mutation.

## Invariants

- No AI-originated request executes a sale, payment, inventory, pricing, refund, supplier/customer, cash-session, order, permission, or other business mutation.
- Request creation and review are server-authoritative, tenant/branch scoped, authenticated, idempotent, and payload-bound.
- Request payload and evidence are immutable after creation.
- Requester cannot approve/reject their own request.
- Review requires `owner`, `admin`, or `manager` authority for the same branch/tenant.
- `anon` and `service_role` do not receive execute grants on request/review RPCs.
- Status lifecycle for this slice is only `pending -> approved|rejected`; no `executed` path exists.
- Every creation/review produces audit evidence.
- Legacy AI mutation-capable RPCs remain revoked.

## TDD sequence

1. Add RED PostgreSQL contract + dedicated CI.
2. Prove missing table/RPCs are the expected RED.
3. Add migration implementing queue, RLS/grant lockdown, request/review RPCs and audit.
4. Verify idempotency, payload binding, tenant/branch isolation, self-approval denial and no execution path.
5. Add read-only approval UI only after database contract is green.
6. Run full regression CI + Windows validation, review, merge with expected-head protection, verify `main`.
