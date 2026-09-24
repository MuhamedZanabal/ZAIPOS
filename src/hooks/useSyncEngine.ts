import { useEffect, useCallback } from 'react';
import { useNetworkStore } from '@/stores/network';
import { db, type SyncQueueItem } from '@/lib/db';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { supabase } from '@/integrations/supabase/client';
import { useTenantStore } from '@/stores/tenant';
import { assertReconciliationAuthority } from '@/lib/syncReconciliation';
import {
  CheckoutDeviceCutoverError,
  classifySyncFailure,
  isActiveQueueStatus,
  isReplayableQueueStatus,
  syncQueueItemBelongsToTenant,
  syncQueueScopeFromPayload,
  UnknownSyncOperationError,
} from '@/lib/syncQueue';

function requireQueuePayload(item: SyncQueueItem): Record<string, unknown> {
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) {
    throw new Error('Offline queue evidence payload is malformed and requires operator review.');
  }
  return item.payload as Record<string, unknown>;
}

async function executeQueueItem(item: SyncQueueItem): Promise<unknown> {
  if (item.type === 'CHECKOUT_SALE_V2' || item.type === 'CHECKOUT_SALE' || item.type === 'CHECKOUT_TABLE_ORDER'
    || item.type === 'APPLY_INVENTORY_MOVEMENT' || item.type === 'ADD_TABLE_ORDER_ITEMS'
    || item.type === 'UPSERT_TABLE_ORDER_ITEMS') {
    // Retain legacy checkout, raw inventory and non-atomic table-item records for
    // operator reconciliation. Never replay them from renderer-held storage or
    // silently translate an untrusted payload into an authorized command.
    throw new CheckoutDeviceCutoverError();
  }
  if (item.type === 'SEND_TO_KITCHEN') {
    const payload = requireQueuePayload(item);
    const { data, error } = await supabase.rpc('transition_table_order_v2' as any, {
      _tenant_id:payload._tenant_id ?? item.tenantId,_branch_id:payload._branch_id ?? item.branchId,
      _order_id:payload._order_id,_operation_id:payload._client_mutation_id ?? item.clientMutationId,
      _action:'send_to_kitchen',
    });
    if (error) throw error;
    return data;
  }
  if (item.type === 'MARK_ORDER_READY') {
    const payload = requireQueuePayload(item);
    const { data, error } = await supabase.rpc('transition_table_order_v2' as any, {
      _tenant_id:payload._tenant_id ?? item.tenantId,_branch_id:payload._branch_id ?? item.branchId,
      _order_id:payload._order_id,_operation_id:payload._client_mutation_id ?? item.clientMutationId,
      _action:'mark_ready',
    });
    if (error) throw error;
    return data;
  }
  if (item.type === 'SEND_TO_CASHIER') {
    const payload = requireQueuePayload(item);
    const { data, error } = await supabase.rpc('transition_table_order_lifecycle_v2' as any, {
      _tenant_id:payload._tenant_id ?? item.tenantId,_branch_id:payload._branch_id ?? item.branchId,
      _order_id:payload._order_id,_operation_id:payload._client_mutation_id ?? item.clientMutationId,
      _action:'send_to_cashier',
    });
    if (error) throw error;
    return data;
  }
  throw new UnknownSyncOperationError(item.type);
}

let activeSyncRun: Promise<void> | null = null;

export function useSyncEngine() {
  const isOnline = useNetworkStore((state) => state.isOnline);
  const setOnline = useNetworkStore((state) => state.setOnline);
  const setPendingSyncCount = useNetworkStore((state) => state.setPendingSyncCount);
  const setSyncAttentionCount = useNetworkStore((state) => state.setSyncAttentionCount);
  const tenantId = useTenantStore((state) => state.tenantId);
  const branchId = useTenantStore((state) => state.branchId);

  const updatePendingCount = useCallback(async () => {
    try {
      if (!tenantId) {
        setPendingSyncCount(0);
        setSyncAttentionCount(0);
        return;
      }
      const tenantItems = (await db.sync_queue.toArray())
        .filter((item) => syncQueueItemBelongsToTenant(item, tenantId));
      const count = tenantItems.filter((item) => isActiveQueueStatus(item.status)).length;
      const attentionCount = tenantItems.filter((item) =>
        item.status === 'failed' || item.status === 'requires_review'
      ).length;
      setPendingSyncCount(count);
      setSyncAttentionCount(attentionCount);
    } catch (error) {
      logger.error('sync_queue_count_failed', { error: String(error) });
    }
  }, [setPendingSyncCount, setSyncAttentionCount, tenantId]);

  const runSyncQueue = useCallback(async () => {
    const onlineNow = typeof navigator === 'undefined' ? isOnline : navigator.onLine;
    if (!onlineNow || !tenantId || !branchId) return;

    try {
      const pendingItems = (await db.sync_queue.toArray())
        .filter((item) =>
          syncQueueItemBelongsToTenant(item, tenantId)
          && (item.branchId ?? syncQueueScopeFromPayload(item.payload).branchId) === branchId
          && isReplayableQueueStatus(item.status)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      if (pendingItems.length === 0) {
        await updatePendingCount();
        return;
      }

      toast.info(`Syncing ${pendingItems.length} pending transactions...`);

      let synced = 0;
      let unresolved = 0;

      for (const item of pendingItems) {
        const startedAt = Date.now();
        try {
          const attemptAt = new Date().toISOString();
          if (item.id !== undefined) {
            await db.sync_queue.update(item.id, {
              status: 'sending',
              lastAttemptAt: attemptAt,
              updatedAt: attemptAt,
            });
          }

          const serverResult = await executeQueueItem(item);
          const committedAt = new Date().toISOString();
          if (item.id !== undefined) {
            await db.sync_queue.update(item.id, {
              status: 'committed',
              committedAt,
              updatedAt: committedAt,
              serverResult: serverResult ?? null,
              error: undefined,
              failureCode: undefined,
            });
          }
          logger.info('sync_queue_item_committed', {
            itemId: item.id,
            type: item.type,
            clientMutationId: item.clientMutationId,
            latency_ms: Date.now() - startedAt,
          });
          synced++;
        } catch (error: unknown) {
          unresolved++;
          const classification = classifySyncFailure(error, item.retryCount);
          logger.error('sync_queue_item_sync_failed', {
            itemId: item.id,
            type: item.type,
            clientMutationId: item.clientMutationId,
            retryCount: classification.retryCount,
            status: classification.status,
            failureCode: classification.failureCode,
            latency_ms: Date.now() - startedAt,
            error: classification.message,
          });
          if (item.id !== undefined) {
            await db.sync_queue.update(item.id, {
              status: classification.status,
              error: classification.message,
              failureCode: classification.failureCode,
              retryCount: classification.retryCount,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }

      await updatePendingCount();
      logger.info('sync_queue_batch_processed', { total: pendingItems.length, synced, unresolved });
      if (unresolved > 0) {
        toast.warning(`${synced} synchronized, ${unresolved} awaiting retry or review`);
      } else {
        toast.success('Synchronization completed successfully');
      }
    } catch (error) {
      logger.error("sync_queue_process_failed", { error: String(error) });
    }
  }, [isOnline, tenantId, branchId, updatePendingCount]);

  const processSyncQueue = useCallback(() => {
    if (activeSyncRun) return activeSyncRun;

    const guardedRun = runSyncQueue().finally(() => {
      if (activeSyncRun === guardedRun) activeSyncRun = null;
    });
    activeSyncRun = guardedRun;
    return guardedRun;
  }, [runSyncQueue]);

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      toast.success('Connection restored', { description: 'Synchronizing data...' });
      processSyncQueue();
    };

    const handleOffline = () => {
      setOnline(false);
      toast.error('Connection lost', { description: 'Offline Mode Active - Saving locally' });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    updatePendingCount();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline, processSyncQueue, updatePendingCount]);

  useEffect(() => {
    if (!isOnline) return;
    const id = window.setInterval(processSyncQueue, 30000);
    return () => window.clearInterval(id);
  }, [isOnline, processSyncQueue]);

  const getQueueItems = useCallback(async () => {
    try {
      if (!tenantId) return [];
      return (await db.sync_queue.toArray())
        .filter((item) => syncQueueItemBelongsToTenant(item, tenantId));
    } catch {
      return [];
    }
  }, [tenantId]);

  const discardItem = useCallback(async (id: number) => {
    try {
      const item = await db.sync_queue.get(id);
      if (!item || !tenantId || !syncQueueItemBelongsToTenant(item, tenantId)
        || item.status === 'requires_review' || item.status === 'resolved') return;
      await db.sync_queue.delete(id);
      await updatePendingCount();
    } catch (error) {
      logger.error("sync_queue_discard_failed", { id, error: String(error) });
    }
  }, [tenantId, updatePendingCount]);

  const retryItem = useCallback(async (id: number) => {
    try {
      const item = await db.sync_queue.get(id);
      if (
        !item
        || !tenantId
        || !syncQueueItemBelongsToTenant(item, tenantId)
        || item.status !== 'failed'
      ) return;
      await db.sync_queue.update(id, {
        status: 'queued',
        retryCount: 0,
        error: undefined,
        failureCode: undefined,
        updatedAt: new Date().toISOString(),
      });
      await updatePendingCount();
    } catch (error) {
      logger.error('sync_queue_retry_failed', { id, error: String(error) });
    }
  }, [tenantId, updatePendingCount]);

  const resolveReviewItem = useCallback(async (
    id: number,
    disposition: 'confirmed_not_applied' | 'reconciled_externally',
    note: string,
  ) => {
    const normalizedNote = note.trim();
    if (normalizedNote.length < 8) throw new Error('A reconciliation note of at least 8 characters is required.');
    const item = await db.sync_queue.get(id);
    if (!item || !tenantId || !syncQueueItemBelongsToTenant(item, tenantId)
      || item.status !== 'requires_review') return;
    const resolvedBy = await assertReconciliationAuthority(tenantId, item.branchId);
    const now = new Date().toISOString();
    await db.sync_queue.update(id, {
      status: 'resolved',
      reconciliationDisposition: disposition,
      reconciliationNote: normalizedNote,
      resolvedAt: now,
      resolvedBy,
      updatedAt: now,
    });
    logger.info('sync_queue_item_reconciled', {
      id, type: item.type, clientMutationId: item.clientMutationId, disposition,
    });
    await updatePendingCount();
  }, [tenantId, updatePendingCount]);

  return { processSyncQueue, getQueueItems, discardItem, retryItem, resolveReviewItem };
}
