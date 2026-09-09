# Product Financial History

ZAIPOS keeps product selling prices and received supplier costs in an exact-fils history ledger. The legacy decimal columns remain compatibility mirrors; they are not the audit record.

## Ledger

`product_prices` records:

- tenant and product;
- optional branch and sales channel scope;
- `selling` or `cost` type;
- exact `amount_fils`;
- effective interval;
- actor, reason, source, and operation ID;
- supplier and purchase-order evidence for received costs.

Only one current row may exist for each base, branch, global-channel, or branch-channel scope. Superseded rows are closed with `effective_to`; they are never overwritten. Tenant/product, tenant/branch, tenant/supplier, and tenant/purchase references use structural foreign keys.

Authenticated application users cannot mutate the ledger directly. Managers use `set_product_base_financials_v1` or `set_product_selling_price_v1`. Both commands require a reason, enforce tenant and branch scope, use stable operation IDs, and emit audit evidence. Catalogue CSV updates and channel-price UI changes call the same commands.

## Received costs and COGS

`purchase_order_items.cost_price_fils` and `line_total_fils` preserve exact BHD values. When `receive_purchase_order_v2` commits a receipt, each linked product line creates one `purchase_receipt` cost event with supplier, order, item, branch, and actor evidence. Replay cannot create a second cost event.

At checkout, each `sale_items` row snapshots:

- `unit_cost_fils`;
- `line_cost_fils`;
- `cost_price_id`;
- `cost_basis`.

These fields are immutable. Later catalogue or supplier-cost changes therefore cannot rewrite historical gross profit. Historical rows that predate this migration are conservatively labelled `legacy_current_cost_at_migration`; ZAIPOS does not pretend that later reconstructed provenance is stronger than the available data.

## Verification

Run:

```bash
npm run test:migrations:product-financial-history
npm run test:migrations:production-chain
npx vitest run src/lib/productFinancialCommands.test.ts src/lib/productFinancialWiring.test.ts
```

The production-chain test covers both a clean install and the supported Bahrain upgrade baseline, including preservation of BHD 1.250 selling price, BHD 0.750 cost, and historical line COGS.
