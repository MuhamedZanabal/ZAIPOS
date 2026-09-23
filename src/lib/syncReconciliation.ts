import { supabase } from '@/integrations/supabase/client';
import type { SyncQueueItem } from './db';

const MANAGER_ROLES = new Set(['owner', 'admin', 'manager', 'super_admin']);

export async function assertReconciliationAuthority(tenantId: string, branchId?: string) {
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw new Error('An authenticated manager is required to reconcile queue evidence.');
  const { data, error } = await supabase.from('user_roles').select('role, branch_id')
    .eq('user_id', auth.user.id).eq('tenant_id', tenantId);
  if (error) throw error;
  const authorized = (data ?? []).some((membership: { role: string; branch_id: string | null }) =>
    MANAGER_ROLES.has(membership.role)
    && (membership.role === 'super_admin' || membership.branch_id === null || membership.branch_id === branchId));
  if (!authorized) throw new Error('Owner, admin, or manager authority is required to reconcile queue evidence.');
  return auth.user.id;
}

export async function buildReconciliationReceipt(item: SyncQueueItem) {
  if (item.status !== 'resolved' || !item.reconciliationDisposition || !item.reconciliationNote || !item.resolvedAt) {
    throw new Error('Only resolved queue evidence can be exported.');
  }
  const evidence = {
    schema: 'zaipos.sync-reconciliation.v1',
    queue_id: item.id ?? null,
    operation_type: item.type,
    client_mutation_id: item.clientMutationId ?? null,
    tenant_id: item.tenantId ?? null,
    branch_id: item.branchId ?? null,
    device_id: item.deviceId ?? null,
    original_created_at: item.createdAt,
    original_payload: item.payload,
    failure_code: item.failureCode ?? null,
    failure_message: item.error ?? null,
    disposition: item.reconciliationDisposition,
    note: item.reconciliationNote,
    resolved_at: item.resolvedAt,
    resolved_by: item.resolvedBy ?? null,
  } as const;
  const bytes = new TextEncoder().encode(JSON.stringify(evidence));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { ...evidence, evidence_sha256: digest };
}

export async function downloadReconciliationReceipt(item: SyncQueueItem) {
  const receipt = await buildReconciliationReceipt(item);
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(receipt, null, 2)}\n`], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = `zaipos-reconciliation-${item.clientMutationId ?? item.id ?? 'evidence'}.json`;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
