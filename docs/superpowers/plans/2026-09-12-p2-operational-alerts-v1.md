# P2 Deterministic Operational Alerts v1

## Goal

Add a read-only, server-authoritative branch alert feed from persisted ZAIPOS evidence. This slice does not use model-generated scores and does not mutate business state.

## V1 alert classes

1. `out_of_stock`: active product branch stock is `<= 0`.
2. `low_stock`: active product branch stock is `> 0` and `<= products.min_stock`.
3. `expired_lot_stock`: lot-controlled physical stock has `quantity_remaining > 0` and `expiry_date < as_of::date`.
4. `expiry_due`: lot-controlled physical stock has `quantity_remaining > 0` and `expiry_date` from `as_of::date` through the explicit caller-supplied expiry horizon.
5. `cash_variance`: a closed cash session inside the lookback window has immutable `difference_fils <> 0`.

## Authority and safety invariants

- Source only persisted PostgreSQL evidence; no AI-estimated metric or fabricated confidence.
- Tenant and branch access remains server-authoritative.
- Money evidence is integer fils only.
- Expiry horizon is explicit input, validated to 0..365 days; no hidden business threshold.
- Cash variance uses immutable closed-session exact-fils evidence.
- Alerts carry source entity IDs and source timestamps/dates sufficient for operator verification.
- Function is `STABLE`, read-only and `SECURITY DEFINER` with a fixed search path.
- Only authenticated branch members may execute it; `PUBLIC`, `anon`, and `service_role` do not receive execute grants.
- No alert can execute, approve, dismiss, modify or create business records in this slice.

## TDD sequence

1. Add RED PostgreSQL/static contract and dedicated workflow.
2. Prove the missing function is the expected RED after a clean production migration chain.
3. Implement the smallest server-authoritative alert RPC.
4. Verify branch isolation, exact evidence, deterministic ordering, and no mutation path.
5. Add a read-only UI only after the database contract is green.
6. Run full regression CI + Windows validation, review, merge with expected-head protection, verify `main`.
