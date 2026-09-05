# P0.5 offline checkout replay

This slice makes the existing IndexedDB operation queue explicit and durable.
It does not create a second financial authority: `checkout_sale_v2` remains the
only command that commits a POS sale, payment allocations, inventory movements,
till buckets and audit evidence.

## State model

| State | Meaning | Automatic behavior |
| --- | --- | --- |
| `queued` | Persisted locally and not yet sent | Eligible for replay while online |
| `sending` | A request attempt started | Replayed after a browser/Electron crash using the same operation ID |
| `committed` | Server returned the authoritative result | Retained locally as commit evidence; never replayed |
| `retrying` | A transient transport attempt failed | Eligible for replay, up to five attempts |
| `failed` | Transient retry ceiling reached | Requires an explicit operator retry |
| `requires_review` | Server rejected stale/invalid business state | Never retried automatically |

Dexie schema version 4 migrates legacy `pending` rows to `queued`, legacy
`success` rows to `committed`, derives tenant/branch scope from persisted
payloads and retains prior timestamps. New records store operation ID, device
ID, tenant, branch, attempt time, failure classification, commit time and the
server result.

Queue reads, counts, replay, retry and discard are filtered to the active
tenant. Sign-out clears product/category/branch caches but does not destroy
queued financial commands. This permits a later authorized session for the
same tenant to finish replay without exposing the record to another tenant.

## Replay and recovery policy

- One module-level single-flight guard serializes reconnect, timer and manual
  sync triggers within the app.
- Offline queue check-and-add runs inside one IndexedDB write transaction.
  Concurrent enqueue attempts for the same stable operation ID therefore
  resolve to one durable row.
- Reusing an existing operation ID is accepted only when operation type and
  payload are deeply equivalent. A different payload is rejected as an
  operation conflict rather than silently deduplicated.
- `sending` is deliberately replayable because the server response may have
  been lost after commit.
- Replay passes the persisted `checkout_sale_v2` payload unchanged. The server
  operation constraint returns the original sale for the same tenant,
  operation ID and request payload.
- Transport failures become `retrying`; the fifth failed attempt becomes
  `failed`.
- Product/stock/coupon/price-total/cash-session/branch/customer/authorization
  and operation-ID conflicts become `requires_review` immediately.
- Unknown operation types are retained for review instead of being deleted as
  successful.
- The POS banner distinguishes active synchronization from transactions that
  need attention. Retrying a blocked row is explicit. Discard requires an
  irreversible-action confirmation.

## Failure-matrix evidence

| Scenario | Automated contract |
| --- | --- |
| Offline before checkout request | `useOfflineMutation.test.ts` queues the exact v2 command without calling the network mutation |
| Connection fails before a response | `useOfflineMutation.test.ts` preserves the payload and operation ID after `Failed to fetch` |
| Server commits but response is lost | `useSyncEngine.test.ts` replays the identical ID and retains the original returned sale ID |
| Browser crashes after request starts | A persisted `sending` row is replayed and moves to `committed` |
| Electron/browser restarts with a pending row | Dexie v4 retains `queued`/`sending`; the replay contract consumes either state |
| Same operation is replayed | PostgreSQL checkout contract returns one sale and proves one stock/payment/till effect |
| Same operation reaches the local queue concurrently | IndexedDB transaction contract creates one row |
| Same operation ID is reused for a different local payload | Queue contract rejects it as an operation conflict |
| Same operation reaches the server from another terminal | Server identity is tenant + client mutation ID, independent of device; replay returns the original sale |
| Stock changed while offline | PostgreSQL contract rejects insufficient stock and proves sale/operation rollback |
| Coupon changed while offline | PostgreSQL contract rejects the coupon and proves no partial checkout effect |
| Product became inactive | PostgreSQL contract rejects the unavailable product and proves no partial checkout effect |
| Price changed while offline | Server-resolved total no longer matches allocations; checkout rolls back |
| Cash session closed | Exact session validation rejects checkout |
| Branch changed/inactive | Active-branch validation rejects checkout |
| Customer changed tenant | Customer tenant validation rejects checkout |
| Server rejects stale transaction | Client classifies deterministic rejection as `requires_review` without automatic replay |

True simultaneous multi-connection stock contention remains part of the P0.7
concurrency gate. This document does not claim that later gate is complete.

## Verification contracts

- `src/lib/syncQueue.test.ts`: status migration, active-state policy and
  deterministic failure classification.
- `src/hooks/useOfflineMutation.test.ts`: offline-before-send,
  transport-failure queueing, exact payload/ID retention, transactional local
  deduplication, different-payload conflict rejection and concurrent enqueue
  serialization.
- `src/hooks/useSyncEngine.test.ts`: response-loss recovery, crash-state replay,
  committed evidence, tenant isolation, single-flight processing, review states,
  retry exhaustion and legacy routing.
- `src/components/shared/OfflineBanner.test.tsx` and
  `SyncQueuePanel.test.tsx`: distinct attention UI, durable result visibility,
  explicit retry and protected discard.
- `src/lib/signOut.test.ts`: retained financial queue with cache clearing.
- `scripts/test-atomic-checkout-v2.mjs`: server idempotency, exact effects and
  stale stock/coupon/product/price/session/branch/customer rollback behavior.

## Production evidence

- Implementation PR: #10
- Final reviewed head: `6dd95e537c0acfe2cec201970d8937621d8f3766`
- RED CI 121: reproduced payload-conflict reuse and concurrent local enqueue races
- Final branch CI 123: green with 16 test files / 99 tests plus the database and build gates
- Squash merge to `main`: `98ba7a07495be218128b351879ea864002b26453`
- Post-merge CI 124: green

P0.5 is complete only for the replay/idempotency scope described above. The
separate P0.7 multi-connection stock-concurrency gate remains open.
