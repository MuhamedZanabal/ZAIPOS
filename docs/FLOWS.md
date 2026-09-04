# ZAIPOS Business Flows

## 1. Physical POS Sale

1. Cashier opens the register for the active Bahrain branch.
2. Products are added by catalogue search, SKU, barcode, or scanner.
3. Branch/channel price is resolved.
4. Product tax rate is included in the sale calculation.
5. Customer, coupon, modifiers, and discount can be attached.
6. Cashier selects Cash, Card, BenefitPay, or Bank Transfer.
7. Checkout runs through the controlled sale RPC with an idempotency key.
8. Inventory, cash-session totals, customer state, and reports are updated.
9. Electron can print the receipt and open the cash drawer for cash sales.

All displayed monetary values use BHD with three decimal places.

## 2. BenefitPay Sale

BenefitPay is shown as a first-class Bahrain payment method. For historical schema compatibility it is stored in the existing QR payment/reconciliation bucket. The UI must call it BenefitPay; internal accounting columns may remain named `qr`.

A BenefitPay selection records the payment method chosen by the cashier. Unless a verified payment-provider response exists, the POS must not invent settlement confirmation.

## 3. Table Service

1. Waiter selects a table.
2. Products/modifiers are added to the table order.
3. KDS items progress through preparation states.
4. Dispatched items are sent to cashier settlement.
5. The cash register settles the order with supported Bahrain payment methods.

## 4. In-House Delivery

1. Staff records the customer name, +973 phone number when available, Bahrain address/area, products, and delivery fee.
2. Delivery moves through Received → Preparing → Ready → Assigned → On the way → Delivered.
3. A courier can be assigned from active staff.
4. Sales/reporting remain linked to the delivery order.

## 5. Talabat Marketplace Order

ZAIPOS provides a Bahrain marketplace ledger for Talabat orders:

1. Staff records/imports the external order reference.
2. Catalogue items and Talabat/channel prices are applied.
3. Platform commission can be tracked.
4. The order can be confirmed into a ZAIPOS sale.

ZAIPOS does not issue undocumented Talabat accept/reject/ready API actions. Those actions require a documented authorized partner integration.

## 6. WhatsApp Order Workflow

WhatsApp conversations can be linked to a Bahrain branch and AI configuration. The agent may search the catalogue, answer supported business questions, and prepare order drafts according to server-side tool permissions. Phone handling should use Bahrain +973 conventions where applicable.

## 7. Cash Register

Opening and closing reconciliation tracks:

- cash;
- card;
- Bank Transfer (internal transfer bucket);
- BenefitPay (internal QR bucket);
- manual cash in/out movements.

Blind-count behavior and role-based difference visibility remain enforced.

## 8. Inventory

Purchases and adjustments change branch stock through controlled inventory operations. Transfers move stock between inventory centres. Sales, production, waste, returns, and consumption create corresponding inventory effects.

## 9. Production

Recipes define required ingredients. Production orders consume inputs and create finished stock. Waste can be recorded separately.

## 10. Offline Sync

Supported mutations can be queued locally. When connectivity returns, the sync engine retries operations with idempotency controls. A network retry must not create a duplicate sale, payment, or stock mutation.

## 11. Bahrain Receipt

A receipt can contain:

- business name;
- Bahrain CR/contact/address information configured by the merchant;
- line items in BHD;
- taxable amount and VAT breakdown when enabled;
- payment method;
- receipt number/date;
- optional customer details and footer.

Receipts and previews must use Bahrain money/tax conventions and the ZAIPOS product identity.
