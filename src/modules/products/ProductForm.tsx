import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RecipeEditor } from "./RecipeEditor";
import { toast } from "sonner";
import { useHardware } from "@/hooks/useHardware";
import { useBarcodeLookup } from "@/hooks/useBarcodeLookup";
import { Loader2, Globe, Plus, Trash2, GripVertical, ImagePlus, X } from "lucide-react";
import { ProductBarcodeFields } from "./ProductBarcodeFields";
import { inspectProductBarcodes, replaceProductBarcodes, type ProductBarcodeInspection } from "@/lib/productBarcodeCommands";
import { normalizeBarcode, type ProductBarcode, type ProductBarcodeType } from "@/lib/productBarcodes";
import { bhdToFils, formatFils } from "@/lib/bahrain";
import { createProductFinancialOperationId, setProductBaseFinancials } from "@/lib/productFinancialCommands";


const TYPES = ["simple", "composite", "production", "combo", "ingredient", "modifier"] as const;
const TYPE_LABELS: Record<string, string> = {
  simple: "Simple",
  composite: "Composite (Recipe)",
  production: "Production / Input",
  combo: "Combo / Package",
  ingredient: "Ingredient / Raw Material",
  modifier: "Modifier / Extra"
};
const COMPOUND = new Set(["composite", "production", "combo"]);
const KDS_STATIONS = [
  { value: "Cocina", label: "Kitchen" },
  { value: "Bar", label: "Bar" },
  { value: "Parrilla", label: "Grill" },
  { value: "Frío", label: "Cold" },
  { value: "Postres", label: "Desserts" },
];

interface Props { tenantId: string; categories: any[]; editing: any; onClose: () => void }

function initialBarcodes(product: any): ProductBarcode[] {
  if (Array.isArray(product?.product_barcodes) && product.product_barcodes.length > 0) {
    return [...product.product_barcodes]
      .sort((left, right) => Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0))
      .map((entry) => ({
        id: entry.id,
        barcode: entry.barcode,
        barcode_type: entry.barcode_type,
        is_primary: entry.is_primary,
      }));
  }
  return product?.barcode
    ? [{ barcode: product.barcode, barcode_type: "legacy", is_primary: true }]
    : [];
}

function typeForScannedCode(code: string): ProductBarcodeType {
  if (/^\d{13}$/.test(code)) return "ean_13";
  if (/^\d{12}$/.test(code)) return "upc_a";
  if (/^\d{8}$/.test(code)) return "ean_8";
  return "code_128";
}

function ModifierGroupEditor({ tenantId, productId }: { tenantId: string; productId: string }) {
  const qc = useQueryClient();
  const [newGroupName, setNewGroupName] = useState("");
  const [newRequired, setNewRequired] = useState(false);
  const [newMax, setNewMax] = useState(1);
  const [addingOption, setAddingOption] = useState<string | null>(null);
  const [optionName, setOptionName] = useState("");
  const [optionPrice, setOptionPrice] = useState("0");

  const { data: groups = [] } = useQuery({
    queryKey: ["modifier-groups", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data } = await supabase
        .from("modifier_groups")
        .select("*, modifier_options(*)")
        .eq("product_id", productId)
        .order("sort_order");
      return data ?? [];
    },
  });

  const addGroup = async () => {
    if (!newGroupName.trim()) return;
    const { error } = await supabase.from("modifier_groups").insert({
      tenant_id: tenantId,
      product_id: productId,
      name: newGroupName.trim(),
      required: newRequired,
      min_selections: newRequired ? 1 : 0,
      max_selections: newMax,
      sort_order: groups.length,
    });
    if (error) return toast.error(error.message);
    setNewGroupName("");
    setNewRequired(false);
    setNewMax(1);
    qc.invalidateQueries({ queryKey: ["modifier-groups", productId] });
  };

  const deleteGroup = async (id: string) => {
    await supabase.from("modifier_groups").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["modifier-groups", productId] });
  };

  const addOption = async (groupId: string) => {
    if (!optionName.trim()) return;
    const { error } = await supabase.from("modifier_options").insert({
      group_id: groupId,
      name: optionName.trim(),
      price_delta: Number(optionPrice) || 0,
    });
    if (error) return toast.error(error.message);
    setOptionName("");
    setOptionPrice("0");
    setAddingOption(null);
    qc.invalidateQueries({ queryKey: ["modifier-groups", productId] });
  };

  const deleteOption = async (id: string) => {
    await supabase.from("modifier_options").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["modifier-groups", productId] });
  };

  return (
    <div className="space-y-4">
      {/* Grupos existentes */}
      {groups.map((g: any) => (
        <div key={g.id} className="glass p-3 space-y-2 rounded-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GripVertical className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm">{g.name}</span>
              {g.required && <span className="g-pill g-pill-bad g-pill-h22">Required</span>}
              <span className="g-pill g-pill-ghost g-pill-h22">max {g.max_selections}</span>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => deleteGroup(g.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Opciones */}
          <div className="pl-6 space-y-1">
            {(g.modifier_options ?? []).map((o: any) => (
              <div key={o.id} className="flex items-center justify-between text-sm py-0.5">
                <span>{o.name}</span>
                <div className="flex items-center gap-2">
                  {o.price_delta !== 0 && (
                    <span className="text-xs text-muted-foreground">
                      {o.price_delta > 0 ? "+" : ""}BHD {Number(o.price_delta).toLocaleString("en-BH", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}
                    </span>
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteOption(o.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}

            {addingOption === g.id ? (
              <div className="flex gap-2 mt-1">
                <Input
                  placeholder="Option name"
                  value={optionName}
                  onChange={e => setOptionName(e.target.value)}
                  className="h-7 text-sm"
                  autoFocus
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOption(g.id); } }}
                />
                <Input
                  type="number"
                  placeholder="+ price"
                  value={optionPrice}
                  onChange={e => setOptionPrice(e.target.value)}
                  className="h-7 text-sm w-24"
                />
                <Button size="sm" className="h-7 text-xs" onClick={() => addOption(g.id)}>OK</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs"
                  onClick={() => { setAddingOption(null); setOptionName(""); setOptionPrice("0"); }}>✕</Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground"
                onClick={() => setAddingOption(g.id)}>
                <Plus className="h-3 w-3 mr-1" /> Add option
              </Button>
            )}
          </div>
        </div>
      ))}

      {/* New grupo */}
      <div className="glass p-3 space-y-2 border-dashed">
        <p className="text-xs font-medium text-muted-foreground">New modifier group</p>
        <div className="flex gap-2">
          <Input
            placeholder="Group name (e.g. Add-ons)"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addGroup(); } }}
          />
          <Input
            type="number"
            min="1"
            value={newMax}
            onChange={e => setNewMax(Number(e.target.value))}
            className="h-8 text-sm w-20"
            title="Maximum selections"
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch checked={newRequired} onCheckedChange={setNewRequired} id="req-switch" />
            <Label htmlFor="req-switch" className="text-xs">Required</Label>
          </div>
          <Button size="sm" onClick={addGroup} disabled={!newGroupName.trim()} className="h-7 text-xs">
            <Plus className="h-3 w-3 mr-1" /> Create group
          </Button>
        </div>
      </div>
    </div>
  );
}

function ComplementariesEditor({ tenantId, productId }: { tenantId: string; productId: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");

  const { data: linked = [] } = useQuery({
    queryKey: ["complementaries", productId],
    enabled: !!productId,
    queryFn: async () => {
      const { data } = await supabase
        .from("product_complementaries")
        .select("complementary_id, products!complementary_id(id, name, price)")
        .eq("product_id", productId)
        .order("sort_order");
      return (data ?? []).map((r: any) => r.products).filter(Boolean);
    },
  });

  const { data: searchResults = [] } = useQuery({
    queryKey: ["products-search-comp", tenantId, search],
    enabled: search.length > 1,
    queryFn: async () => {
      const { data } = await supabase.from("products").select("id, name, price")
        .eq("tenant_id", tenantId).eq("status", "active")
        .neq("id", productId)
        .ilike("name", `%${search}%`)
        .limit(6);
      return data ?? [];
    },
  });

  const addComp = async (compId: string) => {
    if (linked.some((l: any) => l.id === compId)) return;
    await supabase.from("product_complementaries").insert({ product_id: productId, complementary_id: compId, sort_order: linked.length });
    qc.invalidateQueries({ queryKey: ["complementaries", productId] });
    setSearch("");
  };

  const removeComp = async (compId: string) => {
    await supabase.from("product_complementaries").delete()
      .eq("product_id", productId).eq("complementary_id", compId);
    qc.invalidateQueries({ queryKey: ["complementaries", productId] });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        When this product is added to the cart, the POS will suggest these complementary products.
      </p>
      <div className="space-y-1.5">
        <Label className="text-xs">Search product to add</Label>
        <Input placeholder="Product name..." value={search} onChange={e => setSearch(e.target.value)} className="h-8 text-sm" />
        {searchResults.length > 0 && (
          <div className="border rounded-lg divide-y">
            {searchResults.map((p: any) => (
              <button key={p.id} type="button"
                onClick={() => addComp(p.id)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between"
              >
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground"><Plus className="h-3 w-3" /></span>
              </button>
            ))}
          </div>
        )}
      </div>

      {linked.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4">No complementary products defined.</p>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-xs">Complementarios actuales</Label>
          <div className="space-y-1">
            {linked.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between px-3 py-2 border rounded-lg text-sm">
                <span>{p.name}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => removeComp(p.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProductForm({ tenantId, categories, editing, onClose }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<any>(
    editing ?? { name: "", product_type: "simple", price: 0, cost: 0, tax_rate: 10, min_stock: 0, status: "active", category_id: null, sku: "", color: "#c2410c", station: null, description: "", sort_order: 0, image_url: null, requires_detail: false }
  );
  const [barcodes, setBarcodes] = useState<ProductBarcode[]>(() => initialBarcodes(editing));
  const [barcodeIssues, setBarcodeIssues] = useState<ProductBarcodeInspection[]>([]);
  const [draftProductId, setDraftProductId] = useState<string | null>(null);
  const barcodeOperationIdRef = useRef(`product-barcodes-${crypto.randomUUID()}`);
  const financialOperationIdRef = useRef(createProductFinancialOperationId("product-base-financials"));
  const [financialReason, setFinancialReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const scanCleanupRef = useRef<(() => void) | null>(null);
  const { onBarcodeScanned } = useHardware();
  const { lookup: lookupBarcode, loading: lookingUp } = useBarcodeLookup();

  const handleImageUpload = async (file: File) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return toast.error("Only JPEG, PNG, or WebP images are allowed");
    }
    if (file.size > 5 * 1024 * 1024) {
      return toast.error("The image cannot exceed 5 MB");
    }
    setUploadingImage(true);
    try {
      const ext = file.name.split('.').pop() ?? 'jpg';
      const path = `${tenantId}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from('product-images')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const { data: { publicUrl } } = supabase.storage
        .from('product-images')
        .getPublicUrl(path);
      setForm((f: any) => ({ ...f, image_url: publicUrl }));
      toast.success("Imagen subida correctamente");
    } catch (err: any) {
      toast.error(err.message ?? "Error uploading image");
    } finally {
      setUploadingImage(false);
    }
  };

  useEffect(() => {
    if (editing) {
      setForm(editing);
      setBarcodes(initialBarcodes(editing));
      setBarcodeIssues([]);
      setDraftProductId(null);
      barcodeOperationIdRef.current = `product-barcodes-${crypto.randomUUID()}`;
      financialOperationIdRef.current = createProductFinancialOperationId("product-base-financials");
      setFinancialReason("");
    }
  }, [editing]);

  useEffect(() => () => { scanCleanupRef.current?.(); }, []);

  const fetchFromAPI = async () => {
    const primary = barcodes.find((entry) => entry.is_primary)?.barcode;
    if (!primary?.trim()) return;
    const product = await lookupBarcode(primary);
    if (!product) return;
    setForm((f: any) => ({ ...f, name: f.name || product.title, sku: f.sku || product.brand || "" }));
    toast.success(`Found: ${product.title}`, { description: product.brand || product.category });
  };

  const startScan = () => {
    setScanning(true);
    scanCleanupRef.current = onBarcodeScanned((code) => {
      const normalized = normalizeBarcode(code);
      setBarcodes((current) => {
        if (current.some((entry) => normalizeBarcode(entry.barcode) === normalized)) {
          toast.error(`Barcode ${normalized} is already listed`);
          return current;
        }
        return [...current, {
          barcode: normalized,
          barcode_type: typeForScannedCode(normalized),
          is_primary: current.length === 0,
        }];
      });
      setBarcodeIssues([]);
      barcodeOperationIdRef.current = `product-barcodes-${crypto.randomUUID()}`;
      setScanning(false);
      scanCleanupRef.current?.();
      scanCleanupRef.current = null;
    });
    const timer = setTimeout(() => {
      setScanning(false);
      scanCleanupRef.current?.();
      scanCleanupRef.current = null;
    }, 15_000);
    const prev = scanCleanupRef.current;
    scanCleanupRef.current = () => { clearTimeout(timer); prev?.(); };
  };

  const showRecipe = COMPOUND.has(form.product_type) && !!editing?.id;
  const showModifiers = ["simple", "composite", "production", "combo"].includes(form.product_type) && !!editing?.id;
  const showComplementaries = !!editing?.id;

  const { data: financialHistory = [] } = useQuery({
    queryKey: ["product-financial-history", tenantId, editing?.id],
    enabled: !!editing?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_prices")
        .select("id, price_type, amount_fils, branch_id, channel, source, reason, effective_from, effective_to")
        .eq("tenant_id", tenantId)
        .eq("product_id", editing.id)
        .order("effective_from", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const inspection = await inspectProductBarcodes(tenantId, editing?.id ?? draftProductId, barcodes);
      setBarcodeIssues(inspection);
      if (inspection.some((entry) => entry.state !== "valid")) {
        throw new Error("Resolve the highlighted barcode conflicts before saving");
      }
      const sellingAmountFils = bhdToFils(form.price);
      const costAmountFils = bhdToFils(form.cost);
      const financialsChanged = !!editing?.id && (
        sellingAmountFils !== Number(editing.price_fils)
        || costAmountFils !== Number(editing.cost_fils)
      );
      if (financialsChanged && financialReason.trim().length < 3) {
        throw new Error("Enter a reason for the selling-price or cost change");
      }
      const payload = {
        tenant_id: tenantId,
        name: form.name,
        product_type: form.product_type,
        category_id: form.category_id || null,
        sku: form.sku?.trim() || null,
        tax_rate: Number(form.tax_rate), min_stock: Number(form.min_stock),
        unit_id: form.unit_id || null,
        unit_code: form.unit_code || "unit",
        image_url: form.image_url || null,
        color: form.color || null,
        status: form.status,
        station: form.station || null,
        description: form.description?.trim() || null,
        sort_order: Number(form.sort_order) || 0,
        requires_detail: !!form.requires_detail,
      };
      let savedProductId = (editing?.id ?? draftProductId) as string | undefined;
      if (savedProductId) {
        const { error } = await supabase.from("products").update(payload).eq("id", savedProductId).eq("tenant_id", tenantId);
        if (error) throw error;
        if (financialsChanged) {
          await setProductBaseFinancials({
            tenantId,
            productId: savedProductId,
            sellingPriceBhd: form.price,
            costBhd: form.cost,
            reason: financialReason.trim(),
            operationId: financialOperationIdRef.current,
          });
        }
      } else {
        const { data, error } = await supabase.from("products").insert({
          ...payload,
          price: Number(form.price),
          cost: Number(form.cost),
        }).select("id").single();
        if (error) throw error;
        savedProductId = data.id;
        setDraftProductId(savedProductId);
      }
      await replaceProductBarcodes(tenantId, savedProductId!, barcodes, barcodeOperationIdRef.current);
      qc.invalidateQueries({ queryKey: ["product-financial-history", tenantId, savedProductId] });
      toast.success(editing ? "Product updated" : "Product created. Edit it again to add a recipe and modifiers.");
      onClose();
    } catch (err: any) { toast.error(err.message); } finally { setSaving(false); }
  };

  return (
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{editing ? "Edit product" : "New product"}</DialogTitle></DialogHeader>

      <Tabs defaultValue="basic">
        <TabsList>
          <TabsTrigger value="basic">Information</TabsTrigger>
          {showRecipe && <TabsTrigger value="recipe">Recipe</TabsTrigger>}
          {showModifiers && <TabsTrigger value="modifiers">Modificadores</TabsTrigger>}
          {showComplementaries && <TabsTrigger value="complementaries">Upselling</TabsTrigger>}
          {editing?.id && <TabsTrigger value="financial-history">Price history</TabsTrigger>}
        </TabsList>

        <TabsContent value="basic" className="mt-4">
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5"><Label>Name</Label>
              <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>

            {/* Product photo */}
            <div className="space-y-1.5">
              <Label>Product photo</Label>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                aria-label="Upload product photo"
                title="Upload product photo"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); e.target.value = ""; }}
              />
              {form.image_url ? (
                <div className="relative w-full h-40 rounded-lg overflow-hidden border bg-muted">
                  <img src={form.image_url} alt="Product photo" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setForm((f: any) => ({ ...f, image_url: null }))}
                    className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full p-1 transition-colors"
                    title="Quitar imagen"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={uploadingImage}
                  className="w-full h-32 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center gap-2 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                  {uploadingImage
                    ? <Loader2 className="h-6 w-6 animate-spin" />
                    : <ImagePlus className="h-6 w-6" />}
                  <span className="text-sm">{uploadingImage ? "Subiendo…" : "Clic para subir foto"}</span>
                  <span className="text-xs">JPEG, PNG o WebP · max. 5 MB</span>
                </button>
              )}
              {form.image_url && (
                <Button type="button" variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} disabled={uploadingImage}>
                  {uploadingImage ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ImagePlus className="h-3.5 w-3.5 mr-1" />}
                  Cambiar foto
                </Button>
              )}
            </div>

            {/* Description para el menú */}
            <div className="space-y-1.5">
              <Label>Description <span className="text-muted-foreground font-normal">(visible in the QR menu)</span></Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="E.g. Double burger with cheddar cheese, lettuce, and tomato..."
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category_id ?? ""} onValueChange={(v) => setForm({ ...form, category_id: v || null })}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.product_type} onValueChange={(v) => setForm({ ...form, product_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5"><Label>Price</Label>
                <Input type="number" step="0.001" min="0" value={form.price} onChange={(e) => {
                  setForm({ ...form, price: e.target.value });
                  financialOperationIdRef.current = createProductFinancialOperationId("product-base-financials");
                }} />
              </div>
              <div className="space-y-1.5"><Label>Cost</Label>
                <Input type="number" step="0.001" min="0" value={form.cost} onChange={(e) => {
                  setForm({ ...form, cost: e.target.value });
                  financialOperationIdRef.current = createProductFinancialOperationId("product-base-financials");
                }} />
              </div>
              <div className="space-y-1.5"><Label>VAT %</Label>
                <Input type="number" value={form.tax_rate} onChange={(e) => setForm({ ...form, tax_rate: e.target.value })} />
              </div>
            </div>
            {editing?.id && (
              <div className="space-y-1.5">
                <Label>Financial change reason</Label>
                <Textarea
                  value={financialReason}
                  onChange={(event) => {
                    setFinancialReason(event.target.value);
                    financialOperationIdRef.current = createProductFinancialOperationId("product-base-financials");
                  }}
                  placeholder="Required when selling price or cost changes"
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">Price and cost changes are retained in the exact-fils history ledger.</p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>SKU</Label>
                <Input value={form.sku ?? ""} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </div>
              <div className="space-y-1.5"><Label>Minimum stock</Label>
                <Input type="number" value={form.min_stock} onChange={(e) => setForm({ ...form, min_stock: e.target.value })} />
              </div>
            </div>
            {/* KDS station */}
            <div className="space-y-1.5">
              <Label>KDS station</Label>
              <Select value={form.station ?? "none"} onValueChange={(v) => setForm({ ...form, station: v === "none" ? null : v })}>
                <SelectTrigger><SelectValue placeholder="Unassigned (Kitchen by default)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {KDS_STATIONS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <ProductBarcodeFields
              barcodes={barcodes}
              issues={barcodeIssues}
              scanning={scanning}
              onChange={(next) => {
                setBarcodes(next);
                setBarcodeIssues([]);
                barcodeOperationIdRef.current = `product-barcodes-${crypto.randomUUID()}`;
              }}
              onStartScan={startScan}
            />
            <Button type="button" variant="outline" className="w-full"
              onClick={fetchFromAPI} disabled={lookingUp || !barcodes.some((entry) => entry.is_primary && entry.barcode.trim())}>
              {lookingUp ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Globe className="h-4 w-4 mr-2" />}
              Look up primary retail barcode
            </Button>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <Label>Requires details</Label>
                <p className="text-xs text-muted-foreground">When added to an order, a comment is requested and sent to the KDS</p>
              </div>
              <Switch checked={!!form.requires_detail} onCheckedChange={(c) => setForm({ ...form, requires_detail: c })} />
            </div>
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <Label>Active</Label>
              <Switch checked={form.status === "active"} onCheckedChange={(c) => setForm({ ...form, status: c ? "active" : "inactive" })} />
            </div>
            <Button type="submit" className="w-full h-12" disabled={saving}>
              {editing ? "Save changes" : "Create product"}
            </Button>
          </form>
        </TabsContent>

        {showRecipe && (
          <TabsContent value="recipe" className="mt-4">
            <RecipeEditor tenantId={tenantId} parentProductId={editing.id} />
          </TabsContent>
        )}

        {showModifiers && (
          <TabsContent value="modifiers" className="mt-4">
            <p className="text-sm text-muted-foreground mb-3">
              Define add-on or option groups that the cashier/waiter must select when adding this product.
            </p>
            <ModifierGroupEditor tenantId={tenantId} productId={editing.id} />
          </TabsContent>
        )}

        {showComplementaries && (
          <TabsContent value="complementaries" className="mt-4">
            <ComplementariesEditor tenantId={tenantId} productId={editing.id} />
          </TabsContent>
        )}

        {editing?.id && (
          <TabsContent value="financial-history" className="mt-4 space-y-2">
            {financialHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No financial history is available.</p>
            ) : financialHistory.map((entry) => (
              <div key={entry.id} className="rounded-lg border p-3 text-sm flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium capitalize">{entry.price_type} · {formatFils(Number(entry.amount_fils))}</p>
                  <p className="text-xs text-muted-foreground">{entry.reason}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {entry.branch_id ? "Branch" : "Tenant"}{entry.channel ? ` · ${entry.channel}` : " · Base"} · {entry.source}
                  </p>
                </div>
                <div className="text-xs text-muted-foreground text-right whitespace-nowrap">
                  <div>{new Date(entry.effective_from).toLocaleString("en-BH")}</div>
                  <div>{entry.effective_to ? "Superseded" : "Current"}</div>
                </div>
              </div>
            ))}
          </TabsContent>
        )}
      </Tabs>
    </DialogContent>
  );
}
