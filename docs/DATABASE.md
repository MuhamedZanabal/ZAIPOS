# ZAIPOS Database

ZAIPOS uses PostgreSQL through Supabase. The schema is multi-tenant and branch-aware, with Row Level Security protecting tenant data.

## Tenant Model

Primary business records use `tenant_id`. Branch-specific operational records additionally use `branch_id`.

Important entities include:

- `tenants`
- `branches`
- `user_roles`
- `products`, `product_barcodes`, `categories`, `units`
- `branch_products`, `product_channel_prices`
- `inventory_stocks`, inventory movements and centres
- `sales`, `sale_items`, `payments`
- `cash_sessions`, `cash_movements`
- `tables`, table orders and KDS item state
- `delivery_orders`
- `digital_orders`
- customers, suppliers, staff, expenses, production, and AI/WhatsApp tables

## Bahrain Defaults

New tenant defaults are Bahrain-native:

- currency: `BHD`
- standard tax rate: `10`
- active sales channels: Physical POS, Tables, Talabat, WhatsApp, In-house Delivery

Product-level tax rates remain configurable for valid zero-rated or exempt treatment.

## Money

Authoritative transactional money uses exact integer fils. Compatibility numeric columns remain for staged upgrades and legacy consumers, with parity constraints and synchronization triggers. Application display uses BHD with three decimal places. Do not introduce code that rounds Bahrain values to whole units, assumes two-decimal USD-style behavior, or uses binary floating point for authoritative decisions.

## Sales Channels

The supported forward channel set is:

- `pos`
- `tables`
- `talabat`
- `whatsapp`
- `delivery`

PostgreSQL enums can retain historical values when destructive removal would risk existing data or migrations. Such values are compatibility artifacts only.

## Payments

The persisted payment enum currently uses compatibility values:

- `cash`
- `card`
- `transfer`
- `qr`

User-facing mapping:

- `cash` → Cash
- `card` → Card
- `transfer` → Bank Transfer
- `qr` → BenefitPay

Cash-session reconciliation similarly retains `total_qr`/`counted_qr` internally for BenefitPay and transfer columns for Bank Transfer.

## Migrations

Migrations are immutable schema history except where the repository previously contained country-specific demo seed migrations that were replaced during the Bahrain hard cutover. Forward Bahrain migrations:

1. add the `talabat` enum value;
2. apply Bahrain business defaults;
3. migrate the exact inherited demo tenant/catalogue when identifiable;
4. remove inherited seeded demo-account behavior.

Run:

```bash
npm run validate:migrations
```

before deployment.

## Row Level Security

RLS policies and helper functions enforce tenant membership and branch permissions. Sensitive RPCs must validate the authenticated user or service-role context before mutating tenant data.

## Checkout Integrity

Checkout writes sales, items, payments, stock effects, cash-session totals, customer effects, and operation-log/idempotency records as one controlled business flow. Do not split checkout into unrelated client writes that can partially succeed.

## Product barcode integrity

`product_barcodes` is the authoritative tenant-scoped scan-identity ledger. `products.barcode` mirrors the primary row for compatibility. Barcode sets are inspected and replaced through controlled RPCs; direct authenticated ledger mutation is revoked. See `docs/PRODUCT_BARCODES.md` for collision and import behavior.

## Product financial history

`product_prices` is the canonical exact-fils selling-price and received-cost history. `products.price_fils`, `products.cost_fils`, branch prices, and channel prices are current compatibility mirrors. Manager commands close prior effective rows, retain reason/actor/operation evidence, and reject direct authenticated bypass. Purchase receipt costs are linked to supplier/order/item evidence, and checkout snapshots immutable cost evidence on each sale line. See `docs/PRODUCT_FINANCIAL_HISTORY.md`.

## Seed Data

`supabase/seed.sql` is Bahrain-native and intended for local development. Demo values use Bahrain names, +973 phone conventions, Bahrain locations, BHD-scale prices, and 10% standard VAT where applicable. Seed data must remain clearly synthetic and must never be presented as production transactions or customer evidence.
