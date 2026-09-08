# Held and suspended carts

ZAIPOS can suspend an unpaid POS ticket and resume it on another authorized
terminal in the same branch. A held cart is not a sale, payment, stock movement
or reservation.

## Lifecycle

- `hold_cart_v1` persists the branch, cashier, label, channel, optional customer
  and table, quantities, modifiers, discounts and expected unit prices.
- Monetary snapshot values use integer fils. Quantities retain three-decimal
  precision and are never treated as money.
- `list_held_carts_v1` exposes only unresolved carts for the caller's assigned
  branch.
- `preview_held_cart_resume_v1` revalidates current product status, branch
  availability, modifier availability, effective branch/channel price and
  available stock.
- `resume_held_cart_v1` repeats that validation and requires an explicit
  resolution for every changed line. The cashier must accept a current price,
  reduce an insufficient quantity, or remove an unavailable item.
- `discard_held_cart_v1` records a reason and closes the held cart without
  mutating sale or inventory history.

Hold, resume and discard commands are operation-ID idempotent. Direct
application-role writes to `held_carts` and `held_cart_items` are revoked; all
state transitions are branch-authorized server commands with audit evidence.

## POS behavior

Holding clears the active ticket only after the server confirms persistence.
Resuming is allowed only into an empty active ticket so the cashier cannot
silently overwrite current work. The server returns current product and exact
price data used to replace the ticket atomically.

The eventual checkout still passes through `checkout_sale_v2`, which remains
authoritative for price, VAT, stock, cash session, authorization and financial
effects. Held carts do not reserve stock.

## Verification

- `scripts/test-held-carts.mjs`: branch isolation, exact snapshot, price/stock
  conflicts, explicit resolution, idempotency, audit and mutation lockdown.
- `heldCarts.test.ts`: exact-fils serialization and deterministic resolution
  requirements.
- `HeldCarts.test.tsx`: hold and resume UI/RPC wiring.
- `cart.test.ts`: atomic replacement of the active ticket.
- production migration chain: clean installation and required function/table
  shape.
