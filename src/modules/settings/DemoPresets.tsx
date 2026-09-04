import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Coffee, Croissant, Loader2, ShoppingBasket } from "lucide-react";
import { BAHRAIN_CURRENCY, BAHRAIN_STANDARD_VAT } from "@/lib/bahrain";

export type BahrainPresetKey = "supermarket" | "cafeteria" | "bakery";

type PresetProduct = {
  name: string;
  category: string;
  price: number;
  cost: number;
  tax_rate: number;
  unit_code: string;
  initial_stock: number;
};

type Preset = {
  key: BahrainPresetKey;
  label: string;
  description: string;
  business: { name: string; currency: string; tax_rate: number };
  categories: { name: string; color: string }[];
  products: PresetProduct[];
  tables?: { name: string; capacity: number }[];
};

const SUPERMARKET_PRESET: Preset = {
  key: "supermarket",
  label: "Bahrain Supermarket",
  description: "A Bahrain grocery and convenience-store starter catalogue priced in BHD.",
  business: { name: "Amwaj Market Demo", currency: BAHRAIN_CURRENCY, tax_rate: BAHRAIN_STANDARD_VAT },
  categories: [
    { name: "Water & Beverages", color: "#0284c7" },
    { name: "Dairy & Chilled", color: "#2563eb" },
    { name: "Bakery", color: "#b45309" },
    { name: "Rice & Pantry", color: "#ca8a04" },
    { name: "Snacks", color: "#dc2626" },
    { name: "Household", color: "#7c3aed" },
  ],
  products: [
    { name: "Drinking Water 500ml", category: "Water & Beverages", price: 0.100, cost: 0.055, tax_rate: 10, unit_code: "unit", initial_stock: 120 },
    { name: "Drinking Water 1.5L", category: "Water & Beverages", price: 0.200, cost: 0.110, tax_rate: 10, unit_code: "unit", initial_stock: 90 },
    { name: "Orange Juice 1L", category: "Water & Beverages", price: 1.100, cost: 0.720, tax_rate: 10, unit_code: "unit", initial_stock: 30 },
    { name: "Fresh Milk 1L", category: "Dairy & Chilled", price: 0.650, cost: 0.470, tax_rate: 10, unit_code: "unit", initial_stock: 35 },
    { name: "Plain Yogurt 170g", category: "Dairy & Chilled", price: 0.250, cost: 0.160, tax_rate: 10, unit_code: "unit", initial_stock: 50 },
    { name: "White Khubz Pack", category: "Bakery", price: 0.150, cost: 0.080, tax_rate: 10, unit_code: "unit", initial_stock: 60 },
    { name: "Samosa Vegetable", category: "Bakery", price: 0.150, cost: 0.070, tax_rate: 10, unit_code: "unit", initial_stock: 80 },
    { name: "Basmati Rice 5kg", category: "Rice & Pantry", price: 4.950, cost: 3.650, tax_rate: 10, unit_code: "unit", initial_stock: 20 },
    { name: "Dates 500g", category: "Rice & Pantry", price: 1.500, cost: 1.020, tax_rate: 10, unit_code: "unit", initial_stock: 24 },
    { name: "Potato Chips 45g", category: "Snacks", price: 0.250, cost: 0.145, tax_rate: 10, unit_code: "unit", initial_stock: 75 },
    { name: "Chocolate Bar", category: "Snacks", price: 0.350, cost: 0.220, tax_rate: 10, unit_code: "unit", initial_stock: 50 },
    { name: "Dishwashing Liquid 750ml", category: "Household", price: 1.250, cost: 0.820, tax_rate: 10, unit_code: "unit", initial_stock: 18 },
  ],
};

const CAFETERIA_PRESET: Preset = {
  key: "cafeteria",
  label: "Bahrain Cafeteria",
  description: "Karak, breakfast, sandwiches, juices, and quick-service items for a Bahrain cafeteria.",
  business: { name: "Manama Cafeteria Demo", currency: BAHRAIN_CURRENCY, tax_rate: BAHRAIN_STANDARD_VAT },
  categories: [
    { name: "Tea & Coffee", color: "#92400e" },
    { name: "Breakfast", color: "#d97706" },
    { name: "Sandwiches", color: "#65a30d" },
    { name: "Juices", color: "#0891b2" },
    { name: "Desserts", color: "#db2777" },
  ],
  products: [
    { name: "Karak Tea", category: "Tea & Coffee", price: 0.200, cost: 0.075, tax_rate: 10, unit_code: "unit", initial_stock: 100 },
    { name: "Black Tea", category: "Tea & Coffee", price: 0.150, cost: 0.045, tax_rate: 10, unit_code: "unit", initial_stock: 100 },
    { name: "Cappuccino", category: "Tea & Coffee", price: 1.200, cost: 0.420, tax_rate: 10, unit_code: "unit", initial_stock: 80 },
    { name: "Egg & Cheese Breakfast", category: "Breakfast", price: 1.000, cost: 0.430, tax_rate: 10, unit_code: "unit", initial_stock: 30 },
    { name: "Chana Breakfast", category: "Breakfast", price: 0.700, cost: 0.260, tax_rate: 10, unit_code: "unit", initial_stock: 30 },
    { name: "Chicken Shawarma", category: "Sandwiches", price: 1.000, cost: 0.480, tax_rate: 10, unit_code: "unit", initial_stock: 40 },
    { name: "Falafel Sandwich", category: "Sandwiches", price: 0.600, cost: 0.230, tax_rate: 10, unit_code: "unit", initial_stock: 40 },
    { name: "Club Sandwich", category: "Sandwiches", price: 1.800, cost: 0.850, tax_rate: 10, unit_code: "unit", initial_stock: 25 },
    { name: "Fresh Orange Juice", category: "Juices", price: 1.000, cost: 0.400, tax_rate: 10, unit_code: "unit", initial_stock: 35 },
    { name: "Lemon Mint Juice", category: "Juices", price: 1.200, cost: 0.420, tax_rate: 10, unit_code: "unit", initial_stock: 35 },
    { name: "Luqaimat Portion", category: "Desserts", price: 1.000, cost: 0.360, tax_rate: 10, unit_code: "unit", initial_stock: 20 },
  ],
  tables: Array.from({ length: 8 }, (_, index) => ({
    name: `Table ${index + 1}`,
    capacity: index < 4 ? 2 : 4,
  })),
};

const BAKERY_PRESET: Preset = {
  key: "bakery",
  label: "Bahrain Bakery",
  description: "Bread, pastries, cakes, and hot drinks with BHD-scale pricing.",
  business: { name: "Muharraq Bakery Demo", currency: BAHRAIN_CURRENCY, tax_rate: BAHRAIN_STANDARD_VAT },
  categories: [
    { name: "Breads", color: "#b45309" },
    { name: "Pastries", color: "#d97706" },
    { name: "Cakes", color: "#be185d" },
    { name: "Hot Drinks", color: "#7c2d12" },
  ],
  products: [
    { name: "Arabic Bread Pack", category: "Breads", price: 0.200, cost: 0.090, tax_rate: 10, unit_code: "unit", initial_stock: 70 },
    { name: "Whole Wheat Bread", category: "Breads", price: 0.600, cost: 0.280, tax_rate: 10, unit_code: "unit", initial_stock: 30 },
    { name: "Cheese Croissant", category: "Pastries", price: 0.700, cost: 0.300, tax_rate: 10, unit_code: "unit", initial_stock: 35 },
    { name: "Za'atar Croissant", category: "Pastries", price: 0.650, cost: 0.270, tax_rate: 10, unit_code: "unit", initial_stock: 35 },
    { name: "Chicken Puff", category: "Pastries", price: 0.750, cost: 0.330, tax_rate: 10, unit_code: "unit", initial_stock: 30 },
    { name: "Chocolate Cake Slice", category: "Cakes", price: 1.250, cost: 0.520, tax_rate: 10, unit_code: "unit", initial_stock: 18 },
    { name: "Date Cake Slice", category: "Cakes", price: 1.300, cost: 0.540, tax_rate: 10, unit_code: "unit", initial_stock: 18 },
    { name: "Karak Tea", category: "Hot Drinks", price: 0.200, cost: 0.075, tax_rate: 10, unit_code: "unit", initial_stock: 80 },
    { name: "Americano Coffee", category: "Hot Drinks", price: 0.900, cost: 0.260, tax_rate: 10, unit_code: "unit", initial_stock: 60 },
  ],
  tables: Array.from({ length: 6 }, (_, index) => ({ name: `Table ${index + 1}`, capacity: 4 })),
};

export const BAHRAIN_PRESETS: Record<BahrainPresetKey, Preset> = {
  supermarket: SUPERMARKET_PRESET,
  cafeteria: CAFETERIA_PRESET,
  bakery: BAKERY_PRESET,
};

const PRESET_ICONS = {
  supermarket: ShoppingBasket,
  cafeteria: Coffee,
  bakery: Croissant,
};

export function DemoPresets() {
  const { tenantId, branchId } = useTenantContext();
  const qc = useQueryClient();
  const [pending, setPending] = useState<BahrainPresetKey | null>(null);
  const [confirmKind, setConfirmKind] = useState<BahrainPresetKey | null>(null);

  const applyPreset = async (kind: BahrainPresetKey) => {
    if (!tenantId) return toast.error("Select a business first");
    if (!branchId) return toast.error("Select a branch first");

    const preset = BAHRAIN_PRESETS[kind];
    setPending(kind);

    try {
      const { error: tenantError } = await supabase
        .from("tenants")
        .update({
          name: preset.business.name,
          currency: BAHRAIN_CURRENCY,
          tax_rate: BAHRAIN_STANDARD_VAT,
        })
        .eq("id", tenantId);
      if (tenantError) throw tenantError;

      const { data: existingCategories, error: existingCategoriesError } = await supabase
        .from("categories")
        .select("id, name")
        .eq("tenant_id", tenantId);
      if (existingCategoriesError) throw existingCategoriesError;

      const categoryIds = new Map((existingCategories ?? []).map((category) => [category.name, category.id]));
      const missingCategories = preset.categories.filter((category) => !categoryIds.has(category.name));

      if (missingCategories.length > 0) {
        const { data: insertedCategories, error } = await supabase
          .from("categories")
          .insert(missingCategories.map((category, index) => ({
            tenant_id: tenantId,
            name: category.name,
            color: category.color,
            sort_order: index,
          })))
          .select("id, name");
        if (error) throw error;
        insertedCategories?.forEach((category) => categoryIds.set(category.name, category.id));
      }

      const { data: existingProducts, error: existingProductsError } = await supabase
        .from("products")
        .select("id, name, price, tax_rate, product_type")
        .eq("tenant_id", tenantId);
      if (existingProductsError) throw existingProductsError;

      const productByName = new Map((existingProducts ?? []).map((product) => [product.name, product]));
      const productsToInsert = preset.products
        .filter((product) => !productByName.has(product.name))
        .map((product) => ({
          tenant_id: tenantId,
          category_id: categoryIds.get(product.category) ?? null,
          name: product.name,
          product_type: "simple" as const,
          unit_code: product.unit_code,
          price: product.price,
          cost: product.cost,
          tax_rate: product.tax_rate,
          min_stock: 5,
        }));

      if (productsToInsert.length > 0) {
        const { data: insertedProducts, error } = await supabase
          .from("products")
          .insert(productsToInsert)
          .select("id, name, price, tax_rate, product_type");
        if (error) throw error;
        insertedProducts?.forEach((product) => productByName.set(product.name, product));
      }

      const presetNames = new Set(preset.products.map((product) => product.name));
      const productRows = Array.from(productByName.values()).filter((product) => presetNames.has(product.name));

      const { data: currentStocks } = await supabase
        .from("inventory_stocks")
        .select("product_id, quantity")
        .in("product_id", productRows.map((product) => product.id))
        .eq("branch_id", branchId);

      const positiveStockIds = new Set(
        (currentStocks ?? [])
          .filter((stock) => Number(stock.quantity) > 0)
          .map((stock) => stock.product_id)
      );
      const initialStockByName = new Map(preset.products.map((product) => [product.name, product.initial_stock]));

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) throw new Error("There is no active session to apply opening stock");

      let stocked = 0;
      for (const product of productRows) {
        if (positiveStockIds.has(product.id)) continue;
        const quantity = initialStockByName.get(product.name) ?? 0;
        if (quantity <= 0) continue;

        const { error } = await supabase.rpc("apply_inventory_movement", {
          _tenant_id: tenantId,
          _branch_id: branchId,
          _product_id: product.id,
          _movement_type: "purchase",
          _quantity: quantity,
          _reason: `Bahrain demo seed (${kind})`,
          _reference_type: "demo_preset",
          _reference_id: product.id,
          _user_id: session.user.id,
        });
        if (!error) stocked += 1;
      }

      let createdTables = 0;
      if (preset.tables?.length) {
        const { data: existingTables, error: tableReadError } = await supabase
          .from("tables")
          .select("name")
          .eq("tenant_id", tenantId)
          .eq("branch_id", branchId);
        if (tableReadError) throw tableReadError;

        const existingNames = new Set((existingTables ?? []).map((table) => table.name));
        const missingTables = preset.tables
          .filter((table) => !existingNames.has(table.name))
          .map((table, index) => ({
            tenant_id: tenantId,
            branch_id: branchId,
            name: table.name,
            capacity: table.capacity,
            sort_order: index,
          }));

        if (missingTables.length) {
          const { data: insertedTables, error } = await supabase
            .from("tables")
            .insert(missingTables)
            .select("id");
          if (error) throw error;
          createdTables = insertedTables?.length ?? 0;
        }
      }

      toast.success(
        `Bahrain demo applied: ${productsToInsert.length} new products, ${stocked} stocked${createdTables ? `, ${createdTables} tables` : ""}.`
      );
      qc.invalidateQueries();
    } catch (error: any) {
      toast.error(error.message ?? "Could not apply the Bahrain demo");
    } finally {
      setPending(null);
      setConfirmKind(null);
    }
  };

  const presetList = Object.values(BAHRAIN_PRESETS);

  return (
    <div className="glass p-6 space-y-4 border-dashed">
      <div>
        <h3 className="font-semibold">Bahrain demo templates</h3>
        <p className="text-sm text-muted-foreground">
          Apply Bahrain-native BHD/10% starter data to the active business and branch. Demo data adds catalogue and stock only; it does not fabricate historical sales or accounting records.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presetList.map((preset) => {
          const Icon = PRESET_ICONS[preset.key];
          return (
            <button
              key={preset.key}
              type="button"
              disabled={!!pending}
              onClick={() => setConfirmKind(preset.key)}
              className="text-left rounded-lg border p-4 hover:border-primary hover:bg-accent/50 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex items-center gap-2 mb-2">
                {pending === preset.key
                  ? <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  : <Icon className="h-5 w-5 text-primary" />}
                <span className="font-medium">{preset.label}</span>
              </div>
              <p className="text-xs text-muted-foreground mb-2">{preset.description}</p>
              <p className="text-xs text-muted-foreground">
                {preset.categories.length} categories · {preset.products.length} products
                {preset.tables ? ` · ${preset.tables.length} tables` : ""}
              </p>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Product VAT treatment in Bahrain can vary by supply. Review the tax rate of real inventory before production use.
      </p>

      <AlertDialog open={!!confirmKind} onOpenChange={(open) => !open && setConfirmKind(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apply {confirmKind ? BAHRAIN_PRESETS[confirmKind].label : ""} demo?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This changes the demo business identity to a Bahrain example and adds BHD-priced categories, products, opening stock, and tables where applicable. Existing matching products are not duplicated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmKind && applyPreset(confirmKind)}>
              Apply Bahrain demo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
