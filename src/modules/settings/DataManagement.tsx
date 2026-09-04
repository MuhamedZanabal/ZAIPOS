import { useState } from "react";
import { useTenantContext } from "@/hooks/useTenantContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Download, Upload, Loader2, CheckCircle2, AlertCircle, FileSpreadsheet, Box } from "lucide-react";
import { exportToCsv, parseCsv } from "@/lib/csv";
import { applyInventoryMovement } from "@/lib/inventory";
import { toast } from "sonner";
import { useInventoryCenters } from "@/hooks/useInventoryCenters";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
        .select("id, name, sku, barcode, price, cost, tax_rate, min_stock, status, unit_code, product_type")
        .eq("tenant_id", tenantId!);

      if (error) throw error;
      exportToCsv(`products_${new Date().toISOString().split('T')[0]}.csv`, data || []);
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

    setLoading(true);
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        const rows = parseCsv(content);
        
        if (rows.length === 0) {
          toast.error("The file is empty or has an invalid format");
          setLoading(false);
          return;
        }

        setProgress({ total: rows.length, current: 0 });

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const productData = {
            tenant_id: tenantId!,
            name: row.name || row.nombre,
            sku: row.sku || null,
            barcode: row.barcode || row.codigo_barras || null,
            price: Number(row.price || row.price || 0),
            cost: Number(row.cost || row.costo || 0),
            tax_rate: Number(row.tax_rate || row.iva || 0),
            min_stock: Number(row.min_stock || row.stock_minimo || 0),
            status: (row.status || "active") as any,
            unit_code: row.unit_code || "unit",
            product_type: (row.product_type || "simple") as any,
          };

          const id = row.id;
          if (id) {
            await supabase.from("products").update(productData).eq("id", id).eq("tenant_id", tenantId!);
          } else if (productData.sku) {
            // Upsert por SKU si no hay ID
            const { data: existing } = await supabase.from("products").select("id").eq("sku", productData.sku).eq("tenant_id", tenantId!).maybeSingle();
            if (existing) {
              await supabase.from("products").update(productData).eq("id", existing.id);
            } else {
              await supabase.from("products").insert(productData);
            }
          } else {
            await supabase.from("products").insert(productData);
          }

          setProgress(p => p ? { ...p, current: i + 1 } : null);
        }

        toast.success(`Import complete: ${rows.length} products processed`);
        setProgress(null);
      };
      reader.readAsText(file);
    } catch (err: any) {
      toast.error("Import error: " + err.message);
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  };

  const importInventory = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!selectedCenterId) {
      toast.error("You must select an inventory center");
      return;
    }

    setLoading(true);
    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        const content = event.target?.result as string;
        const rows = parseCsv(content);
        
        setProgress({ total: rows.length, current: 0 });

        const { data: { user } } = await supabase.auth.getUser();

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const sku = row.sku;
          const qty = Number(row.quantity || row.quantity || 0);

          if (!sku) continue;

          // Search product por SKU
          const { data: product } = await supabase
            .from("products")
            .select("id")
            .eq("sku", sku)
            .eq("tenant_id", tenantId!)
            .maybeSingle();

          if (product) {
            // Obtener stock actual para calcular el ajuste
            const { data: stock } = await supabase
              .from("inventory_stocks")
              .select("quantity")
              .eq("product_id", product.id)
              .eq("inventory_center_id", selectedCenterId)
              .maybeSingle();

            const currentQty = Number(stock?.quantity || 0);
            const diff = qty - currentQty;

            if (diff !== 0) {
              await applyInventoryMovement({
                tenantId: tenantId!,
                branchId: branchId!,
                productId: product.id,
                inventoryCenterId: selectedCenterId,
                type: "adjustment",
                quantity: diff,
                reason: "Bulk data import",
                userId: user?.id || "",
              });
            }
          }

          setProgress(p => p ? { ...p, current: i + 1 } : null);
        }

        toast.success(`Inventory adjustment complete`);
        setProgress(null);
      };
      reader.readAsText(file);
    } catch (err: any) {
      toast.error("Error importing inventory: " + err.message);
    } finally {
      setLoading(false);
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
                  An adjustment movement will be generated automatically.
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
