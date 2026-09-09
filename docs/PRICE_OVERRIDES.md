# POS Price Overrides

ZAIPOS treats a price override as a short-lived, branch-bound authorization record. The browser never sends an override amount as authoritative checkout data. It sends only an approved request ID, and `checkout_sale_v2` re-resolves the current product, channel, modifier and branch price before consuming that approval.

## Permissions

- `pos.price_override.request`: owner, admin, manager, cashier and waiter
- `pos.price_override.approve`: owner, admin, manager

Permissions are resolved by `has_branch_permission` from the explicit `role_permissions` registry. The server enforces every request and decision; hiding a client control is not authorization. A requester cannot approve their own request.

## Lifecycle

1. The cashier requests an exact integer-fils unit price with a reason, quantity, channel and modifier snapshot.
2. A manager for that tenant and branch approves or rejects the request. Request and decision operation IDs make response-loss retries idempotent.
3. An approval expires after 15 minutes and can be consumed once.
4. Checkout locks the approval, re-resolves the authoritative original price, and rejects changed price, channel, product, modifier, quantity, requester, tenant or branch context.
5. The committed sale item preserves the original price, approving manager, approval time, reason and request ID. Request, decision and consumption each produce audit evidence.

Cart quantity increases and sales-channel changes clear client-side approval evidence. Held carts cannot contain an active approval. If an approved checkout is queued offline and its context changes or the approval expires before replay, the operation moves to `requires_review`; it is never silently repriced.

Direct authenticated inserts, updates and deletes on `role_permissions` and `price_override_requests` are revoked. Approved prices can only affect financial state through the hardened checkout command.
