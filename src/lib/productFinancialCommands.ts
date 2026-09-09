import { supabase } from "@/integrations/supabase/client";
import { bhdToFils } from "./bahrain";
import type { Database } from "@/integrations/supabase/types";

type SalesChannel = Database["public"]["Enums"]["sales_channel"];

export function createProductFinancialOperationId(kind = "product-financial"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

export async function setProductBaseFinancials(input: {
  tenantId: string;
  productId: string;
  sellingPriceBhd: string | number;
  costBhd: string | number;
  reason: string;
  operationId: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("set_product_base_financials_v1", {
    _tenant_id: input.tenantId,
    _product_id: input.productId,
    _selling_amount_fils: bhdToFils(input.sellingPriceBhd),
    _cost_amount_fils: bhdToFils(input.costBhd),
    _reason: input.reason,
    _operation_id: input.operationId,
  });
  if (error) throw error;
  return data as string;
}

export async function setProductSellingPrice(input: {
  tenantId: string;
  productId: string;
  branchId: string | null;
  channel: SalesChannel | null;
  amountBhd: string | number | null;
  reason: string;
  operationId: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("set_product_selling_price_v1", {
    _tenant_id: input.tenantId,
    _product_id: input.productId,
    _branch_id: input.branchId,
    _channel: input.channel,
    _amount_fils: input.amountBhd === null ? null : bhdToFils(input.amountBhd),
    _reason: input.reason,
    _operation_id: input.operationId,
  });
  if (error) throw error;
  return data as string;
}
