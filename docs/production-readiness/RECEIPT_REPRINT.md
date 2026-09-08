# Historical receipt reprinting

ZAIPOS reprints receipts from an immutable server-captured sale snapshot. The
Sales screen never reconstructs a historical receipt from current catalogue,
branch, cashier, customer, price, VAT or payment configuration.

## Persistence and authorization

- `sales.receipt_snapshot` stores the business, branch, cashier, customer,
  item, exact-fils total and payment values that existed when the sale was
  committed.
- Existing Bahrain sales are backfilled during migration. New snapshots are
  captured by a deferred transaction trigger after sale items and payments
  exist.
- `prepare_sale_receipt_reprint_v1` permits an authenticated owner, admin,
  manager or cashier assigned to the sale branch. Cross-tenant and cross-branch
  requests fail closed.
- A tenant-scoped client operation ID makes preparation idempotent and records
  one `sale.receipt_reprint_requested` audit event.
- Application roles have read-only access to `receipt_reprint_events`; direct
  inserts, updates and deletes are revoked.

## Printing lifecycle

The renderer requests the persisted snapshot, converts exact integer fils only
at the printer boundary, and sends one `TicketData` command to Electron. The
printed copy is visibly marked `REPRINT` and uses English Bahrain labels, BHD
with three decimals, VAT, BenefitPay and Bank Transfer terminology.

After the hardware attempt, `complete_sale_receipt_reprint_v1` records exactly
one `printed` or `failed` result and its matching audit event. A printer failure
does not create, retry, reverse or otherwise mutate the original sale.

## Verification

- `scripts/test-receipt-reprint.mjs` verifies immutable historical fidelity,
  exact fils, branch authorization, operation idempotency, mutation lockdown
  and audit outcomes against PostgreSQL.
- `receiptSnapshot.test.ts` verifies that printer data comes only from the
  persisted snapshot.
- `receipt-format.test.ts` verifies three-decimal BHD and Bahrain terminology.
- `Sales.reprint.test.tsx` verifies one prepare, one print and a separately
  recorded hardware outcome.
- `test-production-migration-chain.mjs` verifies clean installation and
  preservation/backfill from the supported Bahrain baseline.

Physical ESC/POS output remains a deployment acceptance test because CI has no
access to the merchant's printer model, connection or paper configuration.
