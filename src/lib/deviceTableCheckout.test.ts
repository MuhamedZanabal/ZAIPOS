import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: mocks.getSession } } }));

import { checkoutTableOrderOnDevice } from './deviceTableCheckout';

const allocation = { method: 'cash' as const, amountFils: 1250, tenderedFils: 1250, changeFils: 0, reference: null };

describe('device table checkout boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'operator-token' } }, error: null });
  });

  it('sends canonical exact BHD and a stable order identity through native custody', async () => {
    const checkoutTableOrder = vi.fn().mockResolvedValue('sale-id');
    window.electron = { checkoutTableOrder } as never;
    const input = {
      tenantId: 'tenant-id', branchId: 'branch-id', orderId: 'order-id',
      allocations: [allocation], tipAmount: 0.25, discountAmount: 0,
    };
    await expect(checkoutTableOrderOnDevice(input)).resolves.toBe('sale-id');
    await expect(checkoutTableOrderOnDevice(input)).resolves.toBe('sale-id');
    expect(checkoutTableOrder).toHaveBeenNthCalledWith(1, {
      _tenant_id: 'tenant-id', _branch_id: 'branch-id', _order_id: 'order-id',
      _payments: [{ method: 'cash', amount: '1.250', reference: null }],
      _tip_amount: '0.250', _discount_total: '0.000', _coupon_code: null,
      _client_mutation_id: 'table-checkout:order-id',
    }, { accessToken: 'operator-token', tenantId: 'tenant-id', branchId: 'branch-id' });
    expect(checkoutTableOrder.mock.calls[1][0]).toEqual(checkoutTableOrder.mock.calls[0][0]);
  });

  it('fails closed without the native bridge or authenticated session', async () => {
    window.electron = undefined;
    await expect(checkoutTableOrderOnDevice({ tenantId: 't', branchId: 'b', orderId: 'o', allocations: [allocation], tipAmount: 0, discountAmount: 0 })).rejects.toThrow(/provisioned desktop/i);
    window.electron = { checkoutTableOrder: vi.fn() } as never;
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(checkoutTableOrderOnDevice({ tenantId: 't', branchId: 'b', orderId: 'o', allocations: [allocation], tipAmount: 0, discountAmount: 0 })).rejects.toThrow(/authenticated desktop/i);
  });
});
