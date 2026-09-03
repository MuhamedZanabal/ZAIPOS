import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Input } from "@/components/ui/input";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Search, Barcode, Trash2, Upload, FileDown, Download, HelpCircle } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { exportToCsv, parseCsv } from "@/lib/csv";
import { ProductForm } from "./ProductForm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

const TYPE_LABELS: Record<string, string> = {
  simple: "Simple",
  composite: "Composite",
  production: "Production",
  combo: "Combo",
  ingredient: "Ingredient",
  modifier: "Modifier"
};

export default function Products() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string>("all");
  const [productType, setProductType] = useState<string>("all");

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: products } = useQuery({
    queryKey: ["products", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase.from("products").select("*, categories(name)")
        .eq("tenant_id", tenantId!).order("name");
      if (error) throw error;
      return data;
    },
  });

  const { data: categories } = useQuery({
    queryKey: ["categories-list", tenantId],
    enabled: !!tenantId,
    queryFn: async () => (await supabase.from("categories").select("id, name").eq("tenant_id", tenantId!).order("name")).data ?? [],
  });

  const filtered = (products ?? []).filter((p: any) => {
    const matchSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.sku ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (p.barcode ?? "").toLowerCase().includes(search.toLowerCase());
    const matchCategory = categoryId === "all" || p.category_id === categoryId;
    const matchType = productType === "all" || p.product_type === productType;
    return matchSearch && matchCategory && matchType;
  });

  const handleDelete = async () => {
    if (!deletingId || !tenantId) return;
    try {
      const { error } = await supabase.from("products").delete().eq("id", deletingId).eq("tenant_id", tenantId);
      if (error) throw error;
      toast({ title: "Product deleted", description: "The product was deleted successfully." });
      qc.invalidateQueries({ queryKey: ["products"] });
    } catch (err: any) {
      toast({ title: "Error deleting", description: err.message, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownloadTemplate = () => {
    const template = [
      { name: "Coca Cola 600ml", category_name: "Drinks", sku: "BEB-001", barcode: "123456789012", price: "2.50", cost: "1.00", product_type: "simple", status: "active" },
      { name: "Burger Meat (10kg Box)", category_name: "Supplies", sku: "INS-001", barcode: "", price: "0", cost: "50.00", product_type: "ingredient", status: "active" },
      { name: "Classic Burger", category_name: "Main Dishes", sku: "PLA-001", barcode: "", price: "8.50", cost: "3.20", product_type: "composite", status: "active" },
      { name: "Burger + Soda Combo", category_name: "Combos", sku: "CMB-001", barcode: "", price: "10.00", cost: "4.20", product_type: "combo", status: "active" }
    ];
    exportToCsv(`product_import_template_${tenantId}.csv`, template);
  };

  const [importFile, setImportFile] = useState<File | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const executeImport = async () => {
    if (!importFile || !tenantId) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = parseCsv(content);
        if (parsed.length === 0) {
          toast({ title: "Error", description: "The file is empty or has an invalid format.", variant: "destructive" });
          return;
        }
        const isValid = parsed.every(row => row.name && row.name.trim() !== "");
        if (!isValid) {
          toast({ title: "Invalid format", description: "Make sure every product has at least a 'name' field.", variant: "destructive" });
          return;
        }
        const mapProductType = (type: string | undefined): string => {
          if (!type) return "simple";
          const normalized = type.trim().toLowerCase();
          switch (normalized) {
            case "standard":
            case "simple":
              return "simple";
            case "raw_material":
            case "ingredient":
              return "ingredient";
            case "manufactured":
            case "composite":
              return "composite";
            case "production":
              return "production";
            case "combo":
              return "combo";
            case "modifier":
              return "modifier";
            default:
              return "simple";
          }
        };
        const dataToInsert = parsed.map(row => {
          let category_id = null;
          if (row.category_name && categories) {
            const matched = categories.find(c => c.name.toLowerCase() === row.category_name.trim().toLowerCase());
            if (matched) category_id = matched.id;
          }
          return {
            tenant_id: tenantId,
            name: row.name,
            category_id,
            sku: row.sku || null,
            barcode: row.barcode || null,
            price: parseFloat(row.price) || 0,
            cost: parseFloat(row.cost) || 0,
            product_type: mapProductType(row.product_type),
            status: row.status || "active",
          };
        });
        const { error: deleteError } = await supabase.from("products").delete().eq("tenant_id", tenantId);
        if (deleteError) {
          console.error("Error al borrar productos:", deleteError);
          if (deleteError.code === "23503") {
            throw new Error("Current products cannot be deleted because they are linked to existing orders, recipes, or inventory movements. Contact support for a deep cleanup.");
          }
          throw new Error("An error occurred while trying to clean the product database.");
        }
        const { error: insertError } = await supabase.from("products").insert(dataToInsert);
        if (insertError) {
          console.error("Error al insertar:", insertError);
          throw new Error("The database was cleaned, but an error occurred while inserting the new products. Verify the category and other fields.");
        }
        toast({ title: "Synchronization successful", description: `Previous data was removed and ${dataToInsert.length} new products were imported.` });
        qc.invalidateQueries({ queryKey: ["products"] });
      } catch (err: any) {
        toast({ title: "Synchronization Error", description: err.message, variant: "destructive" });
      } finally {
        setImportFile(null);
      }
    };
    reader.readAsText(importFile);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex flex-col gap-1">
        <div className="h-display g-page-title">Products</div>
        <div className="h-meta g-page-subtitle">{products?.length ?? 0} products · CATALOG</div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-400" />
          <Input className="pl-9 w-48 lg:w-64" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {categories?.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={productType} onValueChange={setProductType}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="simple">Simple</SelectItem>
            <SelectItem value="composite">Composite</SelectItem>
            <SelectItem value="production">Production</SelectItem>
            <SelectItem value="combo">Combo</SelectItem>
            <SelectItem value="ingredient">Ingredient</SelectItem>
            <SelectItem value="modifier">Modifier</SelectItem>
          </SelectContent>
        </Select>

        {/* Product type guide dialog */}
        <Dialog>
          <DialogTrigger asChild>
            <button type="button" className="g-btn g-btn-ghost g-btn-icon" title="Product type explanation" aria-label="Product type guide">
              <HelpCircle className="h-5 w-5 text-ink-400" />
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Product Type Guide</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid gap-4">
                {[
                  { label: "1. Simple", desc: "Finished product sold directly. Inventory is deducted per unit sold. Example: bottled soda." },
                  { label: "2. Composite", desc: "Product with a recipe. When sold, inventory is deducted from the ingredients defined in its recipe. Example: hamburger." },
                  { label: "3. Production (Production)", desc: "Product prepared in batches to create stock from other ingredients. Example: house sauce or dough." },
                  { label: "4. Combo", desc: "Group of several products sold together at one price. Example: lunch combo." },
                  { label: "5. Ingredient (Ingredient)", desc: "Raw materials not sold on their own and used exclusively in recipes. Example: salt, flour, ground meat." },
                  { label: "6. Modifier", desc: 'Additional options to customize an order. Example: "Extra Bacon" or "No Onion".' },
                ].map(({ label, desc }) => (
                  <div key={label} className="space-y-1">
                    <div className="font-semibold text-sm text-brand-500">{label}</div>
                    <p className="text-sm text-ink-500">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <input type="file" accept=".csv" className="hidden" ref={fileInputRef} onChange={handleFileSelect} title="Import CSV file" aria-label="Import CSV file" />

        <button type="button" className="g-btn g-btn-ghost" onClick={() => fileInputRef.current?.click()} title="Import CSV">
          <Upload className="h-4 w-4" /> Importar
        </button>

        <button type="button" className="g-btn g-btn-ghost" onClick={handleDownloadTemplate} title="Download CSV template">
          <FileDown className="h-4 w-4" /> Plantilla
        </button>

        <button
          type="button"
          className="g-btn g-btn-ghost"
          onClick={() => exportToCsv(`products_${tenantId}.csv`, filtered)}
          title="Export filtered results to CSV"
        >
          <Download className="h-4 w-4" /> Exportar
        </button>

        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <button type="button" className="g-btn g-btn-primary" onClick={() => setEditing(null)}>
              <Plus className="h-4 w-4" />Nuevo
            </button>
          </DialogTrigger>
          <ProductForm
            tenantId={tenantId!}
            categories={categories ?? []}
            editing={editing}
            onClose={() => {
              setOpen(false); setEditing(null);
              qc.invalidateQueries({ queryKey: ["products"] });
              qc.invalidateQueries({ queryKey: ["product-components"] });
            }}
          />
        </Dialog>
      </div>

      {/* Products table */}
      <div className="glass rounded-2xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>SKU / Code</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-ink-500">{p.categories?.name ?? "—"}</TableCell>
                <TableCell>
                  <span className="pill pill-ghost">{TYPE_LABELS[p.product_type] || p.product_type}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5 text-xs tabular-nums text-ink-500">
                    {p.sku && <span>{p.sku}</span>}
                    {p.barcode && (
                      <span className="flex items-center gap-1">
                        <Barcode className="h-3 w-3" />{p.barcode}
                      </span>
                    )}
                    {!p.sku && !p.barcode && <span>—</span>}
                  </div>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatCurrency(Number(p.price))}</TableCell>
                <TableCell className="text-right tabular-nums text-ink-500">{formatCurrency(Number(p.cost))}</TableCell>
                <TableCell>
                  <span className={p.status === "active" ? "pill pill-ok" : "pill pill-ghost"}>
                    {p.status}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      className="g-btn g-btn-ghost g-btn-icon"
                      title="Edit product"
                      aria-label="Edit product"
                      onClick={() => { setEditing(p); setOpen(true); }}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="g-btn g-btn-ghost g-btn-icon g-btn-danger"
                      title="Delete product"
                      aria-label="Delete product"
                      onClick={() => setDeletingId(p.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-ink-400">
                  No products
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete confirm dialog */}
      <AlertDialog open={!!deletingId} onOpenChange={(o) => !o && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete product?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The product will be permanently deleted from the database.
              If it has associated sales history, deletion may not be possible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import confirm dialog */}
      <AlertDialog open={!!importFile} onOpenChange={(o) => !o && setImportFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              ⚠️ Import Warning
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>You are about to import <strong>{importFile?.name}</strong>.</p>
              <p>This action <strong>will delete ALL current products</strong> and replace them with the products in the file.</p>
              <p className="font-semibold text-destructive">Are you completely sure you want to continue with the full deletion and synchronization?</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={executeImport} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Yes, Delete and Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
