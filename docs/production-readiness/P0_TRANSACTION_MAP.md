# P0 transaction map

Baseline inspected: `main` at `171d7d04a1627dead99c5d06a05f42dde69fb24a`.

## Current end-to-end path

| Stage | Current implementation | Persisted effect | Confirmed gap |
| --- | --- | --- | --- |
| Scan | `electron/services/barcode.ts` → `electron/preload.ts` → `useHardware` → `POS.tsx` | None | Scanner lookup matches the single `products.barcode` field; multiple barcodes do not exist. |
| Product resolution | `useProducts.ts`, `POS.tsx` branch availability and `product_channel_prices` overlay, Dexie product/branch caches | Product and branch-price cache | Cache stores decimal `price`; no fils field is consumed. |
| Cart | `stores/cart.ts` | Zustand memory only | Subtotal and tax are JavaScript floating-point calculations. |
| Payment UI | `PaymentDialog.tsx` | None | Four Bahrain methods are shown, but the UI selects one method and produces one allocation. |
| Checkout client | `POS.tsx::finalize` → `useOfflineMutation` | Online RPC or Dexie `sync_queue` | Client supplies `unit_price`, tax, discount, tip and payment amounts as decimal numbers. |
| Checkout server | latest `checkout_sale` definition in `20260515160000_dev_mode_bypass_cash_session.sql` | One database transaction creates sale/items/payments, changes stock and session totals | Server trusts client unit price; payment equality permits a `0.01` BHD tolerance; no prepare command; customer tenant is not explicitly validated. |
| Sale rows | `sales`, `sale_items`, `payments` | Historical sale snapshot plus allocations | Core columns are decimal; many originate as `NUMERIC(12,2)`, which cannot represent all fils values. |
| Inventory | `checkout_sale` → latest `apply_inventory_movement` in `20260515130000_dev_mode_bypass_stock.sql` | `inventory_stocks` upsert and `inventory_movements` append | Sale transaction protects checkout replay, but the general offline inventory command has no operation-level uniqueness. |
| Cash session | `checkout_sale` updates per-method totals; `close_cash_session` derives expected values | `cash_sessions` | Current close logic includes non-cash tenders in `expected_amount`; the cash-only invariant needs a separate canonical field/contract. |
| Receipt | committed sale is fetched in `POS.tsx` → `useHardware` → Electron `printer.ts` | Printed receipt only | Initial print partly rebuilds lines from the in-memory cart and uses client timestamp; reprint/audit are absent. |
| Offline replay | `useOfflineMutation.ts` → Dexie `sync_queue` → `useSyncEngine.ts` | Pending/failed queue item; successful rows are deleted | States are only `pending`, `failed`, `success`; sending/committed/retrying/requires-review and conflict classification are absent. Unknown operations are deleted as successful. |

## Existing safeguards

- `checkout_sale` is a PostgreSQL function, so its writes roll back together on an exception.
- `sales(tenant_id, client_mutation_id)` has a partial unique index.
- Checkout checks `has_branch_role` for permitted roles.
- Stock updates use an atomic upsert and negative-stock guard outside development mode.
- Printer/drawer failure occurs after sale commit and does not replay checkout.
- Cash, Card, BenefitPay (`qr`) and Bank Transfer (`transfer`) are separately persisted.

## P0 invariants and present evidence

| Invariant | Current evidence | State at baseline |
| --- | --- | --- |
| Payment allocations equal committed sale total | Decimal comparison with `0.01` tolerance in `checkout_sale` | Missing exact-fils guarantee |
| Transaction money uses exact fils | No integer-fils schema or shared kernel | Missing |
| Sale changes inventory once | Checkout operation uniqueness plus one transaction | Partial; concurrency/replay integration tests missing |
| Refund cannot exceed remainder | Return function only checks each request against original item quantity | Missing cumulative ceiling |
| Operation causes at most one financial effect | Checkout unique key exists; pre-check has a concurrent replay response race | Partial |
| Tenant/branch isolation | Role check exists; relational tenant consistency is not enforced for every referenced entity | Partial |
| Expected till cash formula | Current cash computation excludes refunds as an explicit input | Missing canonical invariant |
| Sensitive mutations are fully audited | Operation log and some audit events exist | Partial; schema lacks the complete before/after/reason contract |

## First safe dependency slice

1. Add and test exact integer-fils helpers and pure transaction laws.
2. Add Stage A `BIGINT` sidecars, deterministic backfill and legacy-write parity controls.
3. Keep decimal fields authoritative until parity is measured in a real database.
4. Next, introduce a new fils-native checkout command; do not silently change the existing RPC signature.
