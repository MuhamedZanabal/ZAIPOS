import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

type RpcError = { message: string } | null;
type RpcResult = Promise<{ data: unknown; error: RpcError }>;
type RpcInvoker = (name: string, args: Record<string, unknown>) => RpcResult;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcInvoker;

const decimalQuantity = z.union([z.string(), z.number()]).transform(String);
const previewSchema = z.object({
  tenant_id: z.string(),
  source_product_id: z.string(),
  canonical_product_id: z.string(),
  can_merge: z.boolean(),
  blockers: z.array(z.string()),
  source_stock_quantity: decimalQuantity,
  canonical_stock_quantity: decimalQuantity,
  combined_stock_quantity: decimalQuantity,
  source_barcode_count: z.number().int().nonnegative(),
}).passthrough();

const mergeResultSchema = z.object({
  source_product_id: z.string(),
  canonical_product_id: z.string(),
}).passthrough();

export type ProductMergePreview = z.infer<typeof previewSchema>;
export type ProductMergeResult = z.infer<typeof mergeResultSchema>;

export function createProductMergeOperationId(): string {
  return `product-merge-${crypto.randomUUID()}`;
}

export async function previewProductMerge(
  tenantId: string,
  sourceProductId: string,
  canonicalProductId: string,
): Promise<ProductMergePreview> {
  const { data, error } = await rpc("preview_product_merge_v1", {
    _tenant_id: tenantId,
    _source_product_id: sourceProductId,
    _canonical_product_id: canonicalProductId,
  });
  if (error) throw new Error(error.message);
  return previewSchema.parse(data);
}

export async function mergeDuplicateProduct(
  tenantId: string,
  sourceProductId: string,
  canonicalProductId: string,
  reason: string,
  operationId: string,
): Promise<ProductMergeResult> {
  const { data, error } = await rpc("merge_duplicate_product_v1", {
    _tenant_id: tenantId,
    _source_product_id: sourceProductId,
    _canonical_product_id: canonicalProductId,
    _reason: reason,
    _operation_id: operationId,
  });
  if (error) throw new Error(error.message);
  return mergeResultSchema.parse(data);
}
