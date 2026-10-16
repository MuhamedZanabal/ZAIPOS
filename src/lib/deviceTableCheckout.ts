import { supabase } from '@/integrations/supabase/client';
import { bhdToFils, filsToBhd } from '@/lib/bahrain';
import { paymentAllocationsToBhdRows, type PaymentAllocation } from '@/modules/pos/paymentAllocations';
import { enqueue, isServerUnreachable } from '@/lib/offlineOutbox';

export async function checkoutTableOrderOnDevice(input: {
  tenantId: string; branchId: string; orderId: string;
  allocations: PaymentAllocation[]; tipAmount: number; discountAmount: number;
  couponCode?: string;
}): Promise<string | { queued: true }> {
  if (!window.electron?.checkoutTableOrder) throw new Error('Table checkout requires a provisioned desktop terminal.');
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('Authenticated desktop session required.');
  const payload = {
    _tenant_id: input.tenantId,
    _branch_id: input.branchId,
    _order_id: input.orderId,
    _payments: paymentAllocationsToBhdRows(input.allocations),
    _tip_amount: filsToBhd(bhdToFils(String(input.tipAmount))),
    _discount_total: filsToBhd(bhdToFils(String(input.discountAmount))),
    _coupon_code: input.couponCode ?? null,
    _client_mutation_id: `table-checkout:${input.orderId}`,
  };
  try {
    return await window.electron.checkoutTableOrder(payload, {
      accessToken: session.access_token, tenantId: input.tenantId, branchId: input.branchId,
    });
  } catch (err) {
    if (!isServerUnreachable(err)) throw err;
    // Server unreachable: keep the checkout and replay it later. The client
    // mutation id makes the replay idempotent, so a retry never double-charges.
    enqueue({ id: payload._client_mutation_id, kind: 'table-checkout', payload, tenantId: input.tenantId, branchId: input.branchId });
    return { queued: true };
  }
}
