# Product barcodes

ZAIPOS stores scan identities in `product_barcodes`. `products.barcode` remains a compatibility mirror of the one row marked `is_primary`; new application writes must use `replace_product_barcodes_v1`.

## Invariants

- A normalized barcode is unique within a tenant and may be reused by another tenant.
- Normalization trims surrounding whitespace and uses uppercase for deterministic scanner matching.
- A product with barcodes has exactly one primary row after an authoritative replacement.
- `tenant_id` and `product_id` are enforced together by a composite foreign key.
- Authenticated application users cannot insert, update, or delete barcode, conflict, or operation rows directly.
- Owners, admins, and managers replace a complete barcode set through an idempotent operation ID. Cashiers have read-only lookup access within their tenant.
- POS resolution excludes inactive products and uses exact normalized barcode matching. Catalogue and purchasing search may use partial text matching.

## Supported barcode types

`ean_8`, `ean_13`, `upc_a`, `code_128`, `qr`, `internal`, `supplier`, and migration-only `legacy` values are supported. EAN/UPC types enforce their expected numeric length. Other types must be printable, contain no whitespace, and contain at most 128 characters.

## Legacy upgrade and collisions

Migration `20260909040000_product_barcodes.sql` backfills valid unique `products.barcode` values. If historical data contains a malformed code or two products in one tenant share a code:

1. the original value is copied to `product_barcode_conflicts`;
2. the ambiguous legacy mirror is cleared from the candidate product;
3. POS scanning cannot resolve the ambiguous candidate;
4. Products displays a manager review panel;
5. a manager either keeps the existing assignment or dismisses an invalid historical value, with an audit event.

Manual forms and CSV imports call `inspect_product_barcode_candidates_v1` before writing. The response distinguishes malformed input, duplicate input, active-product collisions, and retired-product collisions. A rejected candidate is never silently reassigned.

## Import/export format

The primary barcode remains in the `barcode` column for compatibility. The `barcodes` column contains all codes separated by `|`, with the first entry treated as primary during the transitional import flow. Duplicate codes anywhere in one import file are rejected before product writes. The later staged import-engine programme will replace this transitional row processor.

## Offline behavior

The Dexie product cache stores the full barcode list and indexes it as a multi-entry field. POS scans therefore resolve alternate barcodes while offline using the same normalization and exact-match rules as the connected client.
