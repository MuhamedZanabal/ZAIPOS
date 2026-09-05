import { useEffect, useCallback } from 'react';
import { useNetworkStore } from '@/stores/network';
import { db, type SyncQueueItem } from '@/lib/db';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { supabase } from '@/integrations/supabase/client';
import { useTenantStore } from '@/stores/tenant';
import {
  classifySyncFailure,
  isActiveQueueStatus,
  isReplayableQueueStatus,
  syncQueueItemBelongsToTenant,
  UnknownSyncOperationError,
} from '@/lib/syncQueue';

async function executeQueueItem(item: SyncQueueItem): Promise<unknown> {
  if (item.type === 'CHECKOUT_SALE_V2') {
    const { data, error } = await supabase.rpc('checkout_sale_v2', item.payload as any);
    if (error) throw error;
    return data;
  }
  if (item.type === 'CHECKOUT_SALE') {
    // Legacy queue compatibility. New POS transactions use CHECKOUT_SALE_V2,
    // but already-persisted legacy payloads must keep their original RPC shape.
    const { data, error } = await supabase.rpc('checkout_sale', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'CHECKOUT_TABLE_ORDER') {
    const { data, error } = await supabase.rpc('checkout_table_order', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'SEND_TO_KITCHEN') {
    const { data, error } = await supabase.rpc('send_table_order_to_kitchen', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'MARK_ORDER_READY') {
    const { data, error } = await supabase.rpc('mark_table_order_ready', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'SEND_TO_CASHIER') {
    const { data, error } = await supabase.rpc('send_table_order_to_cashier', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'APPLY_INVENTORY_MOVEMENT') {
    const { data, error } = await supabase.rpc('apply_inventory_movement', item.payload);
    if (error) throw error;
    return data;
  }
  if (item.type === 'ADD_TABLE_ORDER_ITEMS') {
    const { items: orderItems, orderId, tenantId } = item.payload as any;
    const { error } = await supabase.from('table_order_items').insert(
      orderItems.map((orderItem: any) => ({ tenant_id: tenantId, order_id: orderId, ...orderItem }))
    );
    if (error) throw error;
    const { data, error: recalcError } = await supabase.rpc('recalc_table_order', { _order_id: orderId });
    if (recalcError) throw recalcError;
    return data;
  }
  if (item.type === 'UPSERT_TABLE_ORDER_ITEMS') {
    const payload = item.payload as any;
    const { data: orderId, error } = await supabase.rpc('upsert_table_order_items', {
      _tenant_id: payload.tenant_id,
      _branch_id: payload.branch_id,
      _table_id: payload.table_id,
      _waiter_id: payload.waiter_id,
      _items: payload.items,
      _client_mutation_id: payload._client_mutation_id ?? null,
    });
    if (error) throw error;
    if (!orderId) throw new Error('Could not create or update the table order');
    return orderId;
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
    if (!onlineNow || !tenantId) return;

    try {
      const pendingItems = (await db.sync_queue.toArray())
        .filter((item) =>
          syncQueueItemBelongsToTenant(item, tenantId)
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
  }, [isOnline, tenantId, updatePendingCount]);

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
      if (!item || !tenantId || !syncQueueItemBelongsToTenant(item, tenantId)) return;
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
        || (item.status !== 'failed' && item.status !== 'requires_review')
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

  return { processSyncQueue, getQueueItems, discardItem, retryItem };
}
