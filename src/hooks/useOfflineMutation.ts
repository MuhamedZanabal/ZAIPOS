import { useMutation, UseMutationOptions, UseMutationResult } from '@tanstack/react-query';
import { useNetworkStore } from '@/stores/network';
import { db } from '@/lib/db';
import { toast } from 'sonner';
import {
  isActiveQueueStatus,
  isTransientNetworkFailure,
  OfflineOperationConflictError,
  syncQueueItemBelongsToTenant,
  syncQueuePayloadsEqual,
  syncQueueScopeFromPayload,
} from '@/lib/syncQueue';

interface OfflineMutationConfig<TData, TError, TVariables, TContext> 
  extends UseMutationOptions<TData, TError, TVariables, TContext> {
  type: string; // Identificador único para el sync_engine (e.g., 'CREATE_ORDER')
}

export interface OfflineQueuedResult {
  offline: true;
  queued: true;
}

export function useOfflineMutation<TData = unknown, TError = unknown, TVariables = void, TContext = unknown>(
  config: OfflineMutationConfig<TData, TError, TVariables, TContext>
): UseMutationResult<TData, TError, TVariables, TContext> {
  const isOnline = useNetworkStore(state => state.isOnline);
  const setPendingSyncCount = useNetworkStore(state => state.setPendingSyncCount);

  return useMutation({
    ...config,
    mutationFn: async (variables: TVariables) => {
      const queueMutation = async () => {
        await queueOfflineMutation(config.type, variables, setPendingSyncCount);
        toast.success('Saved locally. It will synchronize when the connection returns.');
        return { offline: true, queued: true } as TData;
      };

      if (!isOnline || isBrowserOffline()) return queueMutation();

      // Modo Online: Ejecutar mutación normal
      if (config.mutationFn) {
        try {
          return await config.mutationFn(variables, undefined as never);
        } catch (error) {
          if (isTransientNetworkError(error)) {
            return queueMutation();
          }
          throw error;
        }
      }
      throw new Error("mutationFn is required when online");
    }
  });
}

export async function queueOfflineMutation<TVariables>(
  type: string,
  variables: TVariables,
  setPendingSyncCount: (count: number) => void,
): Promise<OfflineQueuedResult> {
  const deviceId = getDeviceId();
  const payload = withClientMutationId(variables, deviceId);
  const clientMutationId = (payload as any)?._client_mutation_id as string | undefined;
  const { tenantId, branchId } = syncQueueScopeFromPayload(payload);

  await db.transaction('rw', db.sync_queue, async () => {
    const existing = clientMutationId
      ? await db.sync_queue.where('clientMutationId').equals(clientMutationId).first()
      : undefined;

    if (existing) {
      if (existing.type !== type || !syncQueuePayloadsEqual(existing.payload, payload)) {
        throw new OfflineOperationConflictError(clientMutationId!);
      }
      return;
    }

    const now = new Date().toISOString();
    await db.sync_queue.add({
      type,
      payload,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      clientMutationId,
      deviceId,
      tenantId,
      branchId,
    });
  });

  const count = (await db.sync_queue.toArray()).filter((item) =>
    isActiveQueueStatus(item.status)
    && (!tenantId || syncQueueItemBelongsToTenant(item, tenantId))
  ).length;
  setPendingSyncCount(count);

  return { offline: true, queued: true };
}

export function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isTransientNetworkError(error: unknown) {
  return isTransientNetworkFailure(error);
}

function getDeviceId() {
  const key = 'poss360t_device_id';
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(key, created);
  return created;
}

function withClientMutationId<TVariables>(variables: TVariables, deviceId: string): TVariables {
  if (!variables || typeof variables !== 'object') return variables;
  const payload = variables as Record<string, unknown>;
  if (payload._client_mutation_id) return variables;
  return {
    ...payload,
    _client_mutation_id: `${deviceId}:${crypto.randomUUID()}`,
  } as TVariables;
}
