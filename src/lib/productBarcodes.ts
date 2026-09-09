export const PRODUCT_BARCODE_TYPES = [
  "ean_8",
  "ean_13",
  "upc_a",
  "code_128",
  "qr",
  "internal",
  "supplier",
  "legacy",
] as const;

export type ProductBarcodeType = (typeof PRODUCT_BARCODE_TYPES)[number];

export type ProductBarcode = {
  id?: string;
  barcode: string;
  barcode_type: ProductBarcodeType;
  is_primary: boolean;
};

export type BarcodeCandidateState = "valid" | "malformed" | "duplicate_input";

export type BarcodeCandidateAnalysis = ProductBarcode & {
  normalized_barcode: string;
  state: BarcodeCandidateState;
};

type BarcodeProduct = {
  name?: string | null;
  sku?: string | null;
  barcode?: string | null;
  product_barcodes?: ProductBarcode[] | null;
};

export function normalizeBarcode(value: string): string {
  return value.trim().toUpperCase();
}

export function parseBarcodeCell(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[|;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isBarcodeWellFormed(barcode: string, type: ProductBarcodeType): boolean {
  const normalized = normalizeBarcode(barcode);
  if (!/^[!-~]{1,128}$/.test(normalized)) return false;
  if (type === "ean_8") return /^\d{8}$/.test(normalized);
  if (type === "ean_13") return /^\d{13}$/.test(normalized);
  if (type === "upc_a") return /^\d{12}$/.test(normalized);
  return true;
}

export function analyzeBarcodeCandidates(candidates: ProductBarcode[]): BarcodeCandidateAnalysis[] {
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    const normalized = normalizeBarcode(candidate.barcode);
    let state: BarcodeCandidateState = "valid";
    if (!isBarcodeWellFormed(normalized, candidate.barcode_type)) {
      state = "malformed";
    } else if (seen.has(normalized)) {
      state = "duplicate_input";
    }
    seen.add(normalized);
    return { ...candidate, normalized_barcode: normalized, state };
  });
}

function persistedBarcodes(product: BarcodeProduct): string[] {
  if (Array.isArray(product.product_barcodes)) {
    return product.product_barcodes.map((entry) => entry.barcode);
  }
  return product.barcode ? [product.barcode] : [];
}

export function productMatchesBarcode(product: BarcodeProduct, scannedCode: string): boolean {
  const target = normalizeBarcode(scannedCode);
  if (!target) return false;
  if (product.sku && normalizeBarcode(product.sku) === target) return true;
  return persistedBarcodes(product).some((barcode) => normalizeBarcode(barcode) === target);
}

export function productMatchesCatalogueQuery(product: BarcodeProduct, query: string): boolean {
  const target = query.trim().toLocaleLowerCase("en-BH");
  if (!target) return true;
  return [product.name ?? "", product.sku ?? "", ...persistedBarcodes(product)]
    .some((value) => value.toLocaleLowerCase("en-BH").includes(target));
}
