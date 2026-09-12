import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(async () => ({
      data: { operation_id: "catalogue-test", processed: 1, created: 1, updated: 0 },
      error: null,
    })),
  },
}));

import { supabase } from "@/integrations/supabase/client";
import {
  createCatalogueImportOperationId,
  createDeterministicCatalogueProductId,
  importProductCatalogue,
  type CatalogueImportRow,
} from "./catalogueImportCommands";

const row: CatalogueImportRow = {
  id: "58000000-0000-0000-0000-000000000212",
  name: "Imported Water",
  sku: "CAT-NEW",
  selling_amount_fils: 375,
  cost_amount_fils: 225,
  tax_rate: 10,
  min_stock: 3,
  status: "active",
  unit_code: "unit",
  product_type: "simple",
  barcodes: [{ barcode: "6291000000212", barcode_type: "legacy", is_primary: true }],
};

describe("catalogue import client authority", () => {
  it("derives the same product UUID for the same tenant and stable row seed", async () => {
    const first = await createDeterministicCatalogueProductId("18000000-0000-0000-0000-000000000211", "sku:CAT-NEW");
    const replay = await createDeterministicCatalogueProductId("18000000-0000-0000-0000-000000000211", "sku:CAT-NEW");
    const other = await createDeterministicCatalogueProductId("18000000-0000-0000-0000-000000000211", "sku:CAT-OTHER");

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(replay).toBe(first);
    expect(other).not.toBe(first);
  });

  it("derives a stable payload-bound operation id independent of object key order", async () => {
    const reordered = {
      ...row,
      barcodes: row.barcodes.map((barcode) => ({
        is_primary: barcode.is_primary,
        barcode_type: barcode.barcode_type,
        barcode: barcode.barcode,
      })),
    } as CatalogueImportRow;

    const first = await createCatalogueImportOperationId("18000000-0000-0000-0000-000000000211", [row]);
    const replay = await createCatalogueImportOperationId("18000000-0000-0000-0000-000000000211", [reordered]);
    const changed = await createCatalogueImportOperationId("18000000-0000-0000-0000-000000000211", [{ ...row, name: "Changed" }]);

    expect(first).toMatch(/^catalogue-import-[0-9a-f]{64}$/);
    expect(replay).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("submits the complete file through one authoritative RPC", async () => {
    const result = await importProductCatalogue({
      tenantId: "18000000-0000-0000-0000-000000000211",
      operationId: "catalogue-import-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rows: [row],
    });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("import_product_catalogue_v1", {
      _tenant_id: "18000000-0000-0000-0000-000000000211",
      _operation_id: "catalogue-import-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      _rows: [row],
    });
    expect(result.processed).toBe(1);
  });
});
