import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type EntityStatus = Database["public"]["Enums"]["entity_status"];
type ProductType = Database["public"]["Enums"]["product_type"];

export type CatalogueImportBarcode = {
  barcode: string;
  barcode_type: "ean_8" | "ean_13" | "upc_a" | "code_128" | "qr" | "internal" | "supplier" | "legacy";
  is_primary: boolean;
};

export type CatalogueImportRow = {
  id: string;
  name: string;
  sku: string | null;
  selling_amount_fils: number;
  cost_amount_fils: number;
  tax_rate: number;
  min_stock: number;
  status: EntityStatus;
  unit_code: string;
  product_type: ProductType;
  barcodes: CatalogueImportBarcode[];
};

export type CatalogueImportResult = {
  operation_id: string;
  processed: number;
  created: number;
  updated: number;
  request_hash?: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Tenant ID must be a valid UUID");
  return Uint8Array.from(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function formatUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function createDeterministicCatalogueProductId(tenantId: string, stableSeed: string): Promise<string> {
  const namespace = uuidToBytes(tenantId);
  const seed = new TextEncoder().encode(stableSeed.normalize("NFC"));
  const material = new Uint8Array(namespace.length + seed.length);
  material.set(namespace, 0);
  material.set(seed, namespace.length);

  // RFC 9562 UUIDv5: SHA-1(namespace || name), then set version/variant bits.
  // SHA-1 here is an identity derivation primitive, not a security primitive.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", material));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  return formatUuid(uuid);
}

export async function createCatalogueImportOperationId(tenantId: string, rows: CatalogueImportRow[]): Promise<string> {
  const payload = stableJson({ tenant_id: tenantId, rows });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)));
  return `catalogue-import-${bytesToHex(digest)}`;
}

export async function importProductCatalogue(input: {
  tenantId: string;
  operationId: string;
  rows: CatalogueImportRow[];
}): Promise<CatalogueImportResult> {
  const { data, error } = await supabase.rpc("import_product_catalogue_v1" as never, {
    _tenant_id: input.tenantId,
    _operation_id: input.operationId,
    _rows: input.rows,
  } as never);

  if (error) throw error;
  if (!data || typeof data !== "object") throw new Error("Catalogue import returned an invalid result");
  return data as unknown as CatalogueImportResult;
}
