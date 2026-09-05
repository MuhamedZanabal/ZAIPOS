# P0.4 split and mixed payments

This slice connects the cashier payment workflow to the server-authoritative
`checkout_sale_v2` transaction introduced in P0.3. The browser chooses payment
allocations; PostgreSQL remains authoritative for price, VAT, permissions,
cash-session validity, the committed total, inventory and idempotency.

## Supported allocations

| Cashier label | Persisted method | Rule |
| --- | --- | --- |
| Cash | `cash` | May exceed the remaining balance. Only the sale portion is persisted; the excess is shown as change. |
| Card | `card` | Must be positive and cannot exceed the remaining balance. |
| BenefitPay | `qr` | Must be positive and cannot exceed the remaining balance. |
| Bank Transfer | `transfer` | Must be positive and cannot exceed the remaining balance. |

All allocation arithmetic uses integer fils. Complete Sale stays disabled until
the remaining balance is exactly zero. Once the first allocation is added, tip
and coupon controls are locked so the payable total cannot move underneath an
existing allocation set. Removing an allocation reopens its exact balance.

## Commit path

`PaymentDialog` supplies `PaymentAllocation[]` to `POS.tsx`. The live POS builds
one `CHECKOUT_SALE_V2` operation through `buildPosCheckoutCommand` and sends:

- the active tenant and branch;
- the exact open cash-session ID;
- product IDs, quantities, line discounts and modifier IDs;
- one `amount_fils` entry per payment allocation;
- exact order discount and tip fils;
- a stable UUID operation ID.

The client does not send an authoritative unit price or tax rate. Offline queue
replay uses the same operation ID and the same `checkout_sale_v2` payload.

## Persistence and till behavior

The checkout transaction inserts one `payments` row for each allocation. The
cash session updates only the matching bucket (`total_cash`, `total_card`,
`total_qr` or `total_transfer`) and its fils sidecar. A replay of the same
operation returns the original sale without adding payment rows or till totals.

For cash over-tender, the persisted payment and `total_cash` represent the net
cash retained by the till after change. The payment dialog shows the change to
the cashier before completion.

## Receipt and hardware behavior

The initial receipt prints every persisted allocation. The cash drawer is
requested when any allocation is Cash, including a mixed sale, and is not
requested for a fully non-cash split. Printing and drawer actions remain after
the database commit; a hardware failure cannot replay or invalidate the sale.

## Verification contracts

- `paymentAllocations.test.ts`: exact allocation, remaining-balance,
  over-allocation and cash-change rules.
- `PaymentDialog.test.tsx`: cashier allocation workflow, removal, locking and
  exact completion gate.
- `posCheckout.test.ts`: v2 payload, no client price/tax authority, receipt
  allocations and drawer intent.
- `POS.checkout-wiring.test.tsx`: live POS confirmation boundary through the v2
  RPC, exact cash-session binding, split receipt and drawer behavior.
- `scripts/test-atomic-checkout-v2.mjs`: four-method payment persistence,
  isolated till buckets and idempotent replay in PostgreSQL.

The production programme checkbox remains unchecked on a feature branch. It is
updated only after this slice is merged to `main` and the post-merge CI run is
green.
