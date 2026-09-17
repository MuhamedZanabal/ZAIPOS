import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

import {
  acknowledgeCashSession,
  readCashSession,
  recoverCashSession,
  startCashSessionOperation,
  type CashSessionRequest,
} from '@/lib/cashSessionRecovery';

const actor = 'cash-conflict-actor';
const original: CashSessionRequest = {
  kind: 'open',
  tenant_id: 'a9000000-0000-0000-0000-000000000001',
  branch_id: 'b9000000-0000-0000-0000-000000000001',
  register_id: null,
  opening_amount: '1.001',
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: (_name: string, action: () => Promise<unknown>) => action() },
  });
  mocks.rpc.mockResolvedValue({
    data: null,
    error: { code: 'ZS001', message: 'Session operation identity belongs to a different actor or payload' },
  });
});

it('never discards a conflicted operation identity or starts a replacement without reconciliation', async () => {
  const conflict = await startCashSessionOperation(actor, original);
  expect(conflict.state).toBe('rejected');
  const preserved = readCashSession(actor);
  expect(preserved?.operationId).toBe(conflict.operationId);
  expect(preserved?.request).toEqual(original);

  await expect(acknowledgeCashSession(actor)).rejects.toThrow(/reconcil/i);
  expect(readCashSession(actor)).toEqual(preserved);
  await expect(startCashSessionOperation(actor, { ...original, opening_amount: '2.002' }))
    .rejects.toThrow(/saved session request/i);
  expect(mocks.rpc).toHaveBeenCalledTimes(1);

  await recoverCashSession(actor);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
  expect(mocks.rpc.mock.calls[1][1]._operation_id).toBe(preserved?.operationId);
  expect(mocks.rpc.mock.calls[1][1]._request).toEqual(original);
  expect(readCashSession(actor)).toEqual(preserved);
});
