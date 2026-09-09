import { describe, expect, it } from "vitest";
import {
  analyzeBarcodeCandidates,
  normalizeBarcode,
  parseBarcodeCell,
  productMatchesBarcode,
  productMatchesCatalogueQuery,
  type ProductBarcode,
} from "./productBarcodes";

const barcodes: ProductBarcode[] = [
  { barcode: "6290000000777", barcode_type: "ean_13", is_primary: true },
  { barcode: "CASE-24-A", barcode_type: "supplier", is_primary: false },
];

describe("product barcode kernel", () => {
  it("normalizes scanner and import input deterministically", () => {
    expect(normalizeBarcode("  case-24-a\r\n")).toBe("CASE-24-A");
    expect(parseBarcodeCell("6290000000777 | CASE-24-A; inner-6")).toEqual([
      "6290000000777",
      "CASE-24-A",
      "inner-6",
    ]);
  });

  it("matches every persisted barcode without confusing partial scans", () => {
    expect(productMatchesBarcode({ sku: "WATER-01", barcode: null, product_barcodes: barcodes }, "case-24-a")).toBe(true);
    expect(productMatchesBarcode({ sku: "WATER-01", barcode: null, product_barcodes: barcodes }, "CASE-24")).toBe(false);
    expect(productMatchesBarcode({ sku: "WATER-01", barcode: null, product_barcodes: barcodes }, "WATER-01")).toBe(true);
  });

  it("uses alternate barcodes in catalogue search", () => {
    const product = { name: "Bahrain Water", sku: "WATER-01", barcode: null, product_barcodes: barcodes };
    expect(productMatchesCatalogueQuery(product, "case-24")).toBe(true);
    expect(productMatchesCatalogueQuery(product, "water")).toBe(true);
    expect(productMatchesCatalogueQuery(product, "missing")).toBe(false);
  });

  it("detects malformed and duplicate candidates before a write", () => {
    expect(analyzeBarcodeCandidates([
      { barcode: " 6290000000777 ", barcode_type: "ean_13", is_primary: true },
      { barcode: "6290000000777", barcode_type: "ean_13", is_primary: false },
      { barcode: "BAD CODE", barcode_type: "code_128", is_primary: false },
      { barcode: "123", barcode_type: "ean_8", is_primary: false },
    ])).toEqual([
      expect.objectContaining({ normalized_barcode: "6290000000777", state: "valid" }),
      expect.objectContaining({ normalized_barcode: "6290000000777", state: "duplicate_input" }),
      expect.objectContaining({ normalized_barcode: "BAD CODE", state: "malformed" }),
      expect.objectContaining({ normalized_barcode: "123", state: "malformed" }),
    ]);
  });
});
