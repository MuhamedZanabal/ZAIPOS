# ZAIPOS Offline Sync

ZAIPOS is designed to continue supported operations during intermittent connectivity and reconcile them safely when connectivity returns.

## Principles

1. **Queue locally** — supported mutations can be stored in IndexedDB through Dexie.
2. **Retry safely** — the sync engine retries queued work after connectivity returns.
3. **Idempotency first** — sensitive operations use client mutation identifiers or equivalent uniqueness controls.
4. **Server is authoritative** — local cache improves continuity but does not override server-side authorization or transaction rules.
5. **Tenant and branch scope are preserved** — queued operations carry the correct business scope.

## Checkout

Checkout is a high-integrity operation. A retry must not create a duplicate sale, duplicate payment, duplicate BenefitPay record, or duplicate stock movement.

Bahrain-specific presentation rules remain the same offline:

- BHD with three decimal places;
- English UI;
- BenefitPay and Bank Transfer terminology;
- Bahrain branch/customer context.

## Conflict Handling

When a queued operation conflicts with newer server state, the application should surface the failure rather than silently inventing a result. Inventory and transactional conflicts require explicit server validation.

## Cache

TanStack Query state and selected application data can be persisted locally. Cache entries must be invalidated/refetched after successful synchronization when server state may have changed.

## Operational Signals

The UI exposes network/sync state so staff can distinguish:

- online and synchronized;
- offline with local capability;
- queued work waiting to sync;
- failed/stuck mutations requiring attention.

## Testing

Offline tests should cover:

- queue creation;
- reconnect replay;
- idempotent retry;
- duplicate prevention;
- tenant/branch isolation;
- user-visible sync status;
- checkout and inventory behavior under partial connectivity.
