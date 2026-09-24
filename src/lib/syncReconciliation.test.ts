import { describe, expect, it, vi } from 'vitest';
import { buildReconciliationReceipt } from './syncReconciliation';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

describe('sync reconciliation receipts', () => {
  it('exports scoped immutable evidence with a deterministic SHA-256 digest', async () => {
    const item: any = {
      id: 7, type: 'CHECKOUT_SALE', payload: { total_fils: '1250', operation: 'op-1' },
      status: 'resolved', createdAt: '2026-09-23T10:00:00.000Z', retryCount: 1,
      clientMutationId: 'op-1', tenantId: 'tenant-1', branchId: 'branch-1', deviceId: 'device-1',
      failureCode: 'authorization', error: 'Legacy authority retired',
      reconciliationDisposition: 'reconciled_externally', reconciliationNote: 'Matched Z report 42',
      resolvedAt: '2026-09-23T11:00:00.000Z', resolvedBy: 'manager-1',
    };
    const first = await buildReconciliationReceipt(item);
    const second = await buildReconciliationReceipt(structuredClone(item));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: 'zaipos.sync-reconciliation.v1', tenant_id: 'tenant-1', branch_id: 'branch-1',
      original_payload: item.payload, disposition: 'reconciled_externally', resolved_by: 'manager-1',
    });
    expect(first.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses unresolved or incomplete evidence', async () => {
    await expect(buildReconciliationReceipt({ status: 'requires_review' } as any))
      .rejects.toThrow(/only resolved/i);
  });
});
