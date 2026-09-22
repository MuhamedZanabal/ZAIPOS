import { supabase } from '@/integrations/supabase/client';
import { bhdToFils, filsToBhd } from '@/lib/bahrain';
import { paymentAllocationsToBhdRows, type PaymentAllocation } from '@/modules/pos/paymentAllocations';

export async function checkoutTableOrderOnDevice(input: {
  tenantId: string; branchId: string; orderId: string;
  allocations: PaymentAllocation[]; tipAmount: number; discountAmount: number;
  couponCode?: string;
}): Promise<string> {
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
  return window.electron.checkoutTableOrder(payload, {
    accessToken: session.access_token, tenantId: input.tenantId, branchId: input.branchId,
  });
}
