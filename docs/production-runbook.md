# ZAIPOS Production Runbook

## Pre-Deployment Gates

Run and require success for:

```bash
npm ci
npm run validate:migrations
npm run lint
npm run test
npm run build
```

Verify the repository localization audit also passes before release.

## Bahrain Baseline Check

Confirm the deployed tenant uses:

- ZAIPOS branding;
- English interface;
- `en-BH` locale behavior;
- BHD with three decimal places;
- appropriate Bahrain VAT configuration;
- +973 phone conventions;
- Cash, Card, BenefitPay, and Bank Transfer terminology;
- Bahrain sales channels only.

## Database

1. Back up the production database.
2. Apply migrations in timestamp order.
3. Verify tenant/branch RLS policies.
4. Verify Bahrain cutover migrations completed successfully.
5. Confirm no production tenant was unintentionally modified by demo-data cleanup logic.

## POS Verification

- open a register;
- complete cash, card, BenefitPay, and Bank Transfer test sales in the intended test environment;
- verify BHD totals and three-decimal formatting;
- verify receipt output and VAT display;
- verify stock movements;
- verify register reconciliation;
- verify a retry does not duplicate a sale.

## Delivery and Marketplace

- verify Bahrain address/area fields;
- verify +973 customer phone display;
- verify Talabat ledger records can be created and confirmed locally;
- verify no removed marketplace API action is reachable.

## Electron

- verify application title and installer identity are ZAIPOS;
- test printer, drawer, and barcode scanner;
- verify application update configuration;
- verify existing local settings survive where compatibility identifiers were intentionally retained.

## Rollback

Application rollback should use the prior known-good release artifact. Database migrations require migration-specific rollback planning; do not blindly reverse transactional schema changes in production.

## Incident Priorities

1. payment or transaction duplication;
2. tenant/branch isolation failure;
3. data loss or incorrect stock/accounting;
4. inability to sell;
5. synchronization failure;
6. printer/hardware degradation;
7. presentation/localization defects.
