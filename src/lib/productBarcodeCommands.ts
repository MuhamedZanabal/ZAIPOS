import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  analyzeBarcodeCandidates,
  normalizeBarcode,
  type ProductBarcode,
} from "./productBarcodes";

export type ProductBarcodeInspection = ProductBarcode & {
  input_index: number;
  normalized_barcode: string;
  state: "valid" | "malformed" | "duplicate_input" | "database_conflict" | "retired_product_conflict";
  conflicting_product_id?: string | null;
  conflicting_product_name?: string | null;
  conflicting_product_status?: string | null;
};

export function canonicalizeProductBarcodes(barcodes: ProductBarcode[]): ProductBarcode[] {
  const canonical = barcodes.map((entry) => ({
    barcode: normalizeBarcode(entry.barcode),
    barcode_type: entry.barcode_type,
    is_primary: entry.is_primary,
  }));
  const primaryCount = canonical.filter((entry) => entry.is_primary).length;
  if (canonical.length > 64) throw new Error("A product can have at most 64 barcodes");
  if (canonical.length > 0 && primaryCount !== 1) throw new Error("Choose exactly one primary barcode");
  return canonical;
}

export async function inspectProductBarcodes(
  tenantId: string,
  productId: string | null,
  barcodes: ProductBarcode[],
): Promise<ProductBarcodeInspection[]> {
  const canonical = canonicalizeProductBarcodes(barcodes);
  const local = analyzeBarcodeCandidates(canonical);
  if (local.some((entry) => entry.state !== "valid")) {
    return local.map((entry, input_index) => ({ ...entry, input_index })) as ProductBarcodeInspection[];
  }
  const { data, error } = await supabase.rpc("inspect_product_barcode_candidates_v1", {
    _tenant_id: tenantId,
    _product_id: productId,
    _barcodes: canonical as unknown as Json,
  });
  if (error) throw error;
  return (data ?? []) as unknown as ProductBarcodeInspection[];
}

export async function replaceProductBarcodes(
  tenantId: string,
  productId: string,
  barcodes: ProductBarcode[],
  operationId = crypto.randomUUID(),
): Promise<string> {
  const canonical = canonicalizeProductBarcodes(barcodes);
  const { data, error } = await supabase.rpc("replace_product_barcodes_v1", {
    _tenant_id: tenantId,
    _product_id: productId,
    _barcodes: canonical as unknown as Json,
    _operation_id: operationId,
  });
  if (error) throw error;
  return data;
}
