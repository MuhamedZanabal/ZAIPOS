import { useState } from "react";
import { useTenantContext } from "@/hooks/useTenantContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Download, Loader2, AlertCircle, FileSpreadsheet, Box } from "lucide-react";
import { exportToCsv, parseCsv } from "@/lib/csv";
import { createInventoryMutationId, reconcileInventoryLevelsV2 } from "@/lib/inventory";
import { toast } from "sonner";
import { useInventoryCenters } from "@/hooks/useInventoryCenters";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { analyzeBarcodeCandidates, parseBarcodeCell, type ProductBarcode } from "@/lib/productBarcodes";
import { inspectProductBarcodes, replaceProductBarcodes } from "@/lib/productBarcodeCommands";
import type { Database } from "@/integrations/supabase/types";

type DatabaseProductImport = Database["public"]["Tables"]["products"]["Insert"];

export function DataManagement() {
  const { tenantId, branchId } = useTenantContext();
  const { centers, defaultCenter } = useInventoryCenters();
  const [loading, setLoading] = useState(false);
  const [selectedCenterId, setSelectedCenterId] = useState<string>("");
  const [progress, setProgress] = useState<{ total: number; current: number } | null>(null);

  // Auto-select centro por defecto
  if (!selectedCenterId && defaultCenter) {
    setSelectedCenterId(defaultCenter.id);
  }

  const exportProducts = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, sku, barcode, price, cost, tax_rate, min_stock, status, unit_code, product_type, product_barcodes(barcode, barcode_type, is_primary, sort_order)")
        .eq("tenant_id", tenantId!);

      if (error) throw error;
      const exported = (data ?? []).map((product) => ({
        ...product,
        barcode: product.product_barcodes.find((entry) => entry.is_primary)?.barcode ?? "",
        barcodes: product.product_barcodes.map((entry) => entry.barcode).join("|"),
        product_barcodes: undefined,
      }));
      exportToCsv(`products_${new Date().toISOString().split('T')[0]}.csv`, exported);
      toast.success("Catalog exported");
    } catch (err: any) {
      toast.error("Export error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const exportInventory = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("inventory_stocks")
        .select("products(name, sku), inventory_centers(name), quantity")
        .eq("tenant_id", tenantId!)
        .eq("branch_id", branchId!);

      if (error) throw error;

      const flatData = (data || []).map((s: any) => ({
        product: s.products?.name,
        sku: s.products?.sku,
        center: s.inventory_centers?.name,
        quantity: s.quantity
      }));

      exportToCsv(`inventory_${new Date().toISOString().split('T')[0]}.csv`, flatData);
      toast.success("Inventory exported");
    } catch (err: any) {
      toast.error("Export error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const importProducts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!tenantId) {
      toast.error("Tenant context is required");
      e.target.value = "";
      return;
    }
    setLoading(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length === 0) throw new Error("The file is empty or has an invalid format");
      setProgress({ total: rows.length, current: 0 });

      const prepared = [] as Array<{
        existingId: string | null;
        productId: string;
        productData: DatabaseProductImport;
        barcodes: ProductBarcode[];
      }>;
      for (const row of rows) {
        if (!(row.name || row.nombre)) throw new Error("Every product import row requires a name");
        const barcodeValues = parseBarcodeCell(row.barcodes || row.barcode || row.codigo_barras);
        const barcodes: ProductBarcode[] = barcodeValues.map((barcode, index) => ({
          barcode,
          barcode_type: index === 0 ? "legacy" : "supplier",
          is_primary: index === 0,
        }));
        let existingId = row.id || null;
        if (!existingId && row.sku) {
          const { data: existing, error } = await supabase.from("products")
            .select("id").eq("sku", row.sku).eq("tenant_id", tenantId).maybeSingle();
          if (error) throw error;
          existingId = existing?.id ?? null;
        }
        prepared.push({
          existingId,
          productId: existingId ?? crypto.randomUUID(),
          productData: {
            tenant_id: tenantId,
            name: row.name || row.nombre,
            sku: row.sku || null,
            price: Number(row.price || 0),
            cost: Number(row.cost || row.costo || 0),
            tax_rate: Number(row.tax_rate || row.iva || 10),
            min_stock: Number(row.min_stock || row.stock_minimo || 0),
            status: (row.status || "active") as DatabaseProductImport["status"],
            unit_code: row.unit_code || "unit",
            product_type: (row.product_type || "simple") as DatabaseProductImport["product_type"],
          },
          barcodes,
        });
      }

      const localInspection = analyzeBarcodeCandidates(prepared.flatMap((row) => row.barcodes));
      const invalidLocal = localInspection.find((entry) => entry.state !== "valid");
      if (invalidLocal) throw new Error(`Barcode ${invalidLocal.normalized_barcode || "(empty)"} is ${invalidLocal.state.replace("_", " ")} in the import file`);

      for (const row of prepared) {
        const inspection = await inspectProductBarcodes(tenantId, row.existingId, row.barcodes);
        const conflict = inspection.find((entry) => entry.state !== "valid");
        if (conflict) {
          throw new Error(`Barcode ${conflict.normalized_barcode} conflicts with ${conflict.conflicting_product_name ?? "another catalog product"}`);
        }
      }

      for (let index = 0; index < prepared.length; index += 1) {
        const row = prepared[index];
        if (row.existingId) {
          const { error } = await supabase.from("products").update(row.productData)
            .eq("id", row.existingId).eq("tenant_id", tenantId);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("products").insert({ id: row.productId, ...row.productData });
          if (error) throw error;
        }
        await replaceProductBarcodes(tenantId, row.productId, row.barcodes, `data-import-${crypto.randomUUID()}`);
        setProgress({ total: prepared.length, current: index + 1 });
      }

      toast.success(`Import complete: ${rows.length} products processed`);
    } catch (err: any) {
      toast.error("Import error: " + err.message);
    } finally {
      setLoading(false);
      setProgress(null);
      e.target.value = "";
    }
  };

  const importInventory = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!tenantId || !branchId) {
      toast.error("Tenant and branch context are required");
      e.target.value = "";
      return;
    }

    if (!selectedCenterId) {
      toast.error("You must select an inventory center");
      e.target.value = "";
      return;
    }

    setLoading(true);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length === 0) throw new Error("The file is empty or has an invalid format");

      setProgress({ total: rows.length, current: 0 });
      const targets: { productId: string; targetQuantity: number; effectKey: string }[] = [];
      const seenSkus = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sku = String(row.sku ?? "").trim();
        if (!sku) {
          setProgress(p => p ? { ...p, current: i + 1 } : null);
          continue;
        }
        if (seenSkus.has(sku)) throw new Error(`Duplicate SKU in inventory import: ${sku}`);
        seenSkus.add(sku);

        const targetQuantity = Number(row.quantity ?? 0);
        if (!Number.isFinite(targetQuantity) || targetQuantity < 0 || Math.round(targetQuantity * 1000) / 1000 !== targetQuantity) {
          throw new Error(`Invalid physical quantity for SKU ${sku}: use a non-negative value with at most three decimals`);
        }

        const { data: product, error } = await supabase
          .from("products")
          .select("id")
          .eq("sku", sku)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (error) throw error;

        if (product) {
          targets.push({
            productId: product.id,
            targetQuantity,
            effectKey: `sku:${sku}`,
          });
        }

        setProgress(p => p ? { ...p, current: i + 1 } : null);
      }

      if (targets.length === 0) throw new Error("No matching products were found for the imported SKUs");

      await reconcileInventoryLevelsV2({
        tenantId,
        branchId,
        inventoryCenterId: selectedCenterId,
        targets,
        clientMutationId: createInventoryMutationId("inventory-reconcile"),
        reason: "Bulk physical inventory import",
      });

      toast.success(`Inventory reconciliation complete: ${targets.length} product(s) set to their physical counts`);
      setProgress(null);
    } catch (err: any) {
      toast.error("Error importing inventory: " + err.message);
    } finally {
      setLoading(false);
      setProgress(null);
      e.target.value = "";
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Product Catalog */}
        <div className="glass rounded-2xl p-5 space-y-4">
          <div>
            <div className="flex items-center gap-2 text-brand-600">
              <FileSpreadsheet className="h-5 w-5" />
              <div className="g-title-16">Product Catalog</div>
            </div>
            <div className="h-meta mt-1">
              Export or import the complete product list (prices, costs, categories).
            </div>
          </div>
            <Button 
              variant="outline" 
              className="w-full justify-start gap-2 h-12"
              onClick={exportProducts}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export Catalog (.csv)
            </Button>
            
            <div className="space-y-2">
              <Label htmlFor="import-products">Import / Update Catalog</Label>
              <div className="relative">
                <Input 
                  id="import-products" 
                  type="file" 
                  accept=".csv" 
                  onChange={importProducts}
                  className="cursor-pointer"
                  disabled={loading}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                * If you include the 'id' column, the existing product will be updated. 
                Otherwise, the system will try to match by 'sku'.
              </p>
            </div>
        </div>

        {/* Stock de Insalerio */}
        <div className="glass rounded-2xl p-5 space-y-4">
          <div>
            <div className="flex items-center gap-2 text-brand-600">
              <Box className="h-5 w-5" />
              <div className="g-title-16">Stock and Inventory</div>
            </div>
            <div className="h-meta mt-1">
              Bulk-adjust physical quantities in your inventory centers.
            </div>
          </div>
            <Button 
              variant="outline" 
              className="w-full justify-start gap-2 h-12"
              onClick={exportInventory}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export Current Stock (.csv)
            </Button>

            <div className="space-y-3 pt-2 border-t">
              <div className="space-y-1.5">
                <Label>Destination center for import</Label>
                <Select value={selectedCenterId} onValueChange={setSelectedCenterId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a center..." />
                  </SelectTrigger>
                  <SelectContent>
                    {centers.map(c => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="import-inventory">Import Stock (Physical Adjustment)</Label>
                <Input 
                  id="import-inventory" 
                  type="file" 
                  accept=".csv" 
                  onChange={importInventory}
                  className="cursor-pointer"
                  disabled={loading || !selectedCenterId}
                />
                <p className="text-[10px] text-muted-foreground">
                  * The file must contain 'sku' and 'quantity' columns. 
                  Each quantity is treated as the authoritative physical count for the selected center.
                </p>
              </div>
            </div>
        </div>
      </div>

      {progress && (
        <Alert className="bg-primary/5 border-primary/20 animate-pulse">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <AlertTitle>Processing data...</AlertTitle>
          <AlertDescription>
            Processing row {progress.current} of {progress.total}
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Recommendation</AlertTitle>
        <AlertDescription>
          Export your data before a bulk import so you have a backup.
        </AlertDescription>
      </Alert>
    </div>
  );
}
