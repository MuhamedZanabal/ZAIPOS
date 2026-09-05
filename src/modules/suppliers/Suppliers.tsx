import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useInventoryCenters } from "@/hooks/useInventoryCenters";
import { receivePurchaseOrderV2 } from "@/lib/inventory";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Truck, Plus, Pencil, Trash2, Search, ShoppingBag, CheckCircle2 } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { toast } from "sonner";

type Supplier = { id: string; name: string; tax_id: string | null; contact_name: string | null; phone: string | null; email: string | null; payment_terms: string | null; notes: string | null; status: string };
type Product = { id: string; name: string; sku: string | null; cost: number };
type PurchaseOrder = { id: string; supplier_id: string | null; status: string; total: number; notes: string | null; received_at: string | null; created_at: string; suppliers?: { name: string } | null };
type OrderItem = { product_id: string; product_name: string; quantity: number; cost_price: number };

type SupplierForm = { name: string; tax_id: string; contact_name: string; phone: string; email: string; payment_terms: string; notes: string };
const emptySupplier: SupplierForm = { name: "", tax_id: "", contact_name: "", phone: "", email: "", payment_terms: "", notes: "" };

export default function Suppliers() {
  const { tenantId, branchId } = useTenantContext();
  const { defaultCenter } = useInventoryCenters();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"suppliers" | "orders">("suppliers");
  const [search, setSearch] = useState("");

  // Supplier state
  const [supplierOpen, setSupplierOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [supplierForm, setSupplierForm] = useState<SupplierForm>(emptySupplier);

  // Purchase order state
  const [orderOpen, setOrderOpen] = useState(false);
  const [orderSupplierId, setOrderSupplierId] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [itemProductId, setItemProductId] = useState("");
  const [itemQty, setItemQty] = useState("");
  const [itemCost, setItemCost] = useState("");

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["suppliers", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("suppliers").select("*").eq("tenant_id", tenantId!).order("name");
      return (data ?? []) as Supplier[];
    },
  });

  const { data: orders = [] } = useQuery<PurchaseOrder[]>({
    queryKey: ["purchase-orders", branchId],
    enabled: !!branchId,
    queryFn: async () => {
      const { data } = await supabase.from("purchase_orders")
        .select("*, suppliers(name)")
        .eq("branch_id", branchId!)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as PurchaseOrder[];
    },
  });

  const { data: products = [] } = useQuery<Product[]>({
    queryKey: ["products-simple", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("products").select("id, name, sku, cost").eq("tenant_id", tenantId!).eq("status", "active").order("name");
      return (data ?? []) as Product[];
    },
  });

  const saveSupplier = useMutation({
    mutationFn: async (f: SupplierForm) => {
      const payload = { tenant_id: tenantId!, name: f.name.trim(), tax_id: f.tax_id.trim() || null, contact_name: f.contact_name.trim() || null, phone: f.phone.trim() || null, email: f.email.trim() || null, payment_terms: f.payment_terms.trim() || null, notes: f.notes.trim() || null };
      if (editingSupplier) {
        const { error } = await supabase.from("suppliers").update(payload).eq("id", editingSupplier.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("suppliers").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editingSupplier ? "Supplier updated" : "Supplier created");
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      setSupplierOpen(false); setEditingSupplier(null); setSupplierForm(emptySupplier);
    },
    onError: (e: any) => toast.error(e.message ?? "Error"),
  });

  const removeSupplier = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("suppliers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Supplier deleted"); qc.invalidateQueries({ queryKey: ["suppliers"] }); },
    onError: (e: any) => toast.error(e.message ?? "Error"),
  });

  const createOrder = useMutation({
    mutationFn: async () => {
      const total = orderItems.reduce((s, i) => s + i.quantity * i.cost_price, 0);
      const { data: ord, error: e1 } = await supabase.from("purchase_orders").insert({
        tenant_id: tenantId!, branch_id: branchId!, supplier_id: orderSupplierId || null, total, notes: orderNotes.trim() || null,
      }).select("id").single();
      if (e1) throw e1;

      if (orderItems.length > 0) {
        const items = orderItems.map((i) => ({
          order_id: ord.id, tenant_id: tenantId!, product_id: i.product_id, product_name: i.product_name, quantity: i.quantity, cost_price: i.cost_price, line_total: i.quantity * i.cost_price,
        }));
        const { error: e2 } = await supabase.from("purchase_order_items").insert(items);
        if (e2) throw e2;
      }
    },
    onSuccess: () => {
      toast.success("Purchase order created");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      setOrderOpen(false); setOrderSupplierId(""); setOrderNotes(""); setOrderItems([]);
    },
    onError: (e: any) => toast.error(e.message ?? "Error"),
  });

  const receiveOrder = useMutation({
    mutationFn: async (order: PurchaseOrder) => {
      if (!defaultCenter?.id) throw new Error("No active inventory center is configured for this branch");
      return receivePurchaseOrderV2({
        orderId: order.id,
        inventoryCenterId: defaultCenter.id,
        clientMutationId: `purchase-order-receive-${order.id}`,
      });
    },
    onSuccess: () => {
      toast.success("Order received · Inventory updated exactly once");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["stocks"] });
      qc.invalidateQueries({ queryKey: ["pos-stocks"] });
      qc.invalidateQueries({ queryKey: ["movements"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Error receiving order"),
  });

  const addOrderItem = () => {
    const product = products.find((p) => p.id === itemProductId);
    if (!product || !itemQty) return;
    const qty = parseFloat(itemQty);
    const cost = parseFloat(itemCost) || Number(product.cost);
    setOrderItems((prev) => [...prev, { product_id: product.id, product_name: product.name, quantity: qty, cost_price: cost }]);
    setItemProductId(""); setItemQty(""); setItemCost("");
  };

  const filteredSuppliers = suppliers.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    (s.tax_id ?? "").includes(search) ||
    (s.contact_name ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const orderTotal = orderItems.reduce((s, i) => s + i.quantity * i.cost_price, 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="orb">
            <Truck className="h-5 w-5" />
          </div>
          <div>
            <div className="h-meta g-page-subtitle text-ink-400">INVENTORY · SUPPLIERS</div>
            <h1 className="h-display g-page-title">Suppliers</h1>
            <div className="h-meta g-page-subtitle text-ink-500">
              {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="g-btn g-btn-ghost"
            onClick={() => { setOrderOpen(true); setTab("orders"); }}
          >
            <ShoppingBag className="h-4 w-4" />
            New purchase order
          </button>
          <button
            type="button"
            className="g-btn g-btn-primary"
            onClick={() => { setEditingSupplier(null); setSupplierForm(emptySupplier); setSupplierOpen(true); }}
          >
            <Plus className="h-4 w-4" />
            New supplier
          </button>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 glass-thin rounded-xl w-fit">
        <button
          type="button"
          className={`g-btn ${tab === "suppliers" ? "g-btn-primary" : "g-btn-ghost"} g-btn-sm`}
          onClick={() => setTab("suppliers")}
        >
          Suppliers
        </button>
        <button
          type="button"
          className={`g-btn ${tab === "orders" ? "g-btn-primary" : "g-btn-ghost"} g-btn-sm`}
          onClick={() => setTab("orders")}
        >
          Purchase orders
        </button>
      </div>

      {/* Suppliers tab */}
      {tab === "suppliers" && (
        <div className="space-y-4">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-400" />
            <Input className="pl-9" placeholder="Search supplier..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {filteredSuppliers.length === 0 ? (
            <div className="glass rounded-2xl p-12 text-center">
              <div className="orb mx-auto mb-4">
                <Truck className="h-7 w-7" />
              </div>
              <h2 className="h-display font-semibold text-lg">No suppliers</h2>
              <p className="h-meta g-page-subtitle text-ink-500 mt-1">
                Register suppliers to manage purchasing and inventory.
              </p>
            </div>
          ) : (
            <div className="glass rounded-2xl overflow-hidden">
              <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr_72px] gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-400 border-b border-white/10">
                <span>Name</span>
                <span>NIT</span>
                <span>Contact</span>
                <span>Phone</span>
                <span>Payment terms</span>
                <span />
              </div>
              {filteredSuppliers.map((s, idx) => (
                <div
                  key={s.id}
                  className={`grid grid-cols-[2fr_1fr_1fr_1fr_1.5fr_72px] gap-3 px-4 py-3 items-center hover:bg-white/5 transition-colors${idx < filteredSuppliers.length - 1 ? " border-b border-white/10" : ""}`}
                >
                  <span className="font-medium text-sm text-ink-900">{s.name}</span>
                  <span className="text-sm tabular-nums text-ink-500">{s.tax_id ?? "—"}</span>
                  <span className="text-sm text-ink-700">{s.contact_name ?? "—"}</span>
                  <span className="text-sm text-ink-700">{s.phone ?? "—"}</span>
                  <span className="text-sm text-ink-500">{s.payment_terms ?? "—"}</span>
                  <div className="flex gap-1 justify-end">
                    <button
                      type="button"
                      aria-label="Edit supplier"
                      className="g-btn g-btn-ghost h-8 w-8 p-0 flex items-center justify-center"
                      onClick={() => {
                        setEditingSupplier(s);
                        setSupplierForm({ name: s.name, tax_id: s.tax_id ?? "", contact_name: s.contact_name ?? "", phone: s.phone ?? "", email: s.email ?? "", payment_terms: s.payment_terms ?? "", notes: s.notes ?? "" });
                        setSupplierOpen(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete supplier"
                      className="g-btn g-btn-ghost h-8 w-8 p-0 flex items-center justify-center text-g-bad"
                      onClick={() => { if (confirm("Delete supplier?")) removeSupplier.mutate(s.id); }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Orders tab */}
      {tab === "orders" && (
        orders.length === 0 ? (
          <div className="glass rounded-2xl p-12 text-center">
            <div className="orb mx-auto mb-4">
              <ShoppingBag className="h-7 w-7" />
            </div>
            <h2 className="h-display font-semibold text-lg">No purchase orders</h2>
            <p className="h-meta g-page-subtitle text-ink-500 mt-1">
              Create purchase orders to record purchases from suppliers.
            </p>
          </div>
        ) : (
          <div className="glass rounded-2xl overflow-hidden">
            <div className="grid grid-cols-[1fr_2fr_100px_2fr_120px_100px] gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-400 border-b border-white/10">
              <span>Date</span>
              <span>Supplier</span>
              <span>Status</span>
              <span>Notes</span>
              <span className="text-right">Total</span>
              <span />
            </div>
            {orders.map((o, idx) => (
              <div
                key={o.id}
                className={`grid grid-cols-[1fr_2fr_100px_2fr_120px_100px] gap-3 px-4 py-3 items-center hover:bg-white/5 transition-colors${idx < orders.length - 1 ? " border-b border-white/10" : ""}`}
              >
                <span className="text-sm tabular-nums text-ink-500">{new Date(o.created_at).toLocaleDateString("en-BH")}</span>
                <span className="font-medium text-sm text-ink-900">{o.suppliers?.name ?? "No supplier"}</span>
                <span>
                  {o.status === "received" && <span className="g-pill g-pill-ok">Recibida</span>}
                  {o.status === "cancelled" && <span className="g-pill g-pill-bad">Cancelada</span>}
                  {o.status === "draft" && <span className="g-pill g-pill-ghost">Borrador</span>}
                </span>
                <span className="text-sm text-ink-500">{o.notes ?? "—"}</span>
                <span className="text-right font-semibold tabular-nums text-sm text-ink-900">{formatCurrency(Number(o.total))}</span>
                <div className="flex justify-end">
                  {o.status === "draft" && (
                    <button
                      type="button"
                      className="g-btn g-btn-ghost g-btn-sm flex items-center gap-1"
                      onClick={() => { if (confirm("Mark as received? This will update inventory.")) receiveOrder.mutate(o); }}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Recibir
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Supplier form dialog */}
      <Dialog open={supplierOpen} onOpenChange={(v) => { setSupplierOpen(v); if (!v) { setEditingSupplier(null); setSupplierForm(emptySupplier); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editingSupplier ? "Edit supplier" : "New supplier"}</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Name / Legal name *</Label>
              <Input value={supplierForm.name} onChange={(e) => setSupplierForm((f) => ({ ...f, name: e.target.value }))} placeholder="Distribuidora XYZ" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>NIT</Label>
                <Input value={supplierForm.tax_id} onChange={(e) => setSupplierForm((f) => ({ ...f, tax_id: e.target.value }))} placeholder="900000000-1" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={supplierForm.phone} onChange={(e) => setSupplierForm((f) => ({ ...f, phone: e.target.value }))} placeholder="310 000 0000" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Contact</Label>
                <Input value={supplierForm.contact_name} onChange={(e) => setSupplierForm((f) => ({ ...f, contact_name: e.target.value }))} placeholder="John Smith" />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={supplierForm.email} onChange={(e) => setSupplierForm((f) => ({ ...f, email: e.target.value }))} placeholder="sales@supplier.com" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Payment terms</Label>
              <Input value={supplierForm.payment_terms} onChange={(e) => setSupplierForm((f) => ({ ...f, payment_terms: e.target.value }))} placeholder="E.g. Net 30, cash, 15-day credit" />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Input value={supplierForm.notes} onChange={(e) => setSupplierForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Observaciones adicionales" />
            </div>
            <button
              type="button"
              className="g-btn g-btn-primary w-full"
              disabled={!supplierForm.name.trim() || saveSupplier.isPending}
              onClick={() => saveSupplier.mutate(supplierForm)}
            >
              {saveSupplier.isPending ? "Saving..." : editingSupplier ? "Save changes" : "Create supplier"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Purchase order dialog */}
      <Dialog open={orderOpen} onOpenChange={(v) => { setOrderOpen(v); if (!v) { setOrderSupplierId(""); setOrderNotes(""); setOrderItems([]); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Supplier</Label>
                <Select value={orderSupplierId} onValueChange={setOrderSupplierId}>
                  <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Notes</Label>
                <Input value={orderNotes} onChange={(e) => setOrderNotes(e.target.value)} placeholder="Order notes" />
              </div>
            </div>

            <div className="glass-thin rounded-xl p-3 space-y-3">
              <div className="text-sm font-semibold text-ink-900">Add products</div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                <div className="space-y-1">
                  <Label className="text-xs">Product</Label>
                  <Select value={itemProductId} onValueChange={(v) => { setItemProductId(v); const p = products.find((x) => x.id === v); if (p) setItemCost(String(p.cost)); }}>
                    <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>{products.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 w-24">
                  <Label className="text-xs">Quantity</Label>
                  <Input type="number" step="0.001" min="0.001" value={itemQty} onChange={(e) => setItemQty(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1 w-28">
                  <Label className="text-xs">Unit cost</Label>
                  <Input type="number" step="0.001" min="0" value={itemCost} onChange={(e) => setItemCost(e.target.value)} placeholder="0" />
                </div>
                <button
                  type="button"
                  aria-label="Add product"
                  className="g-btn g-btn-ghost"
                  onClick={addOrderItem}
                  disabled={!itemProductId || !itemQty}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {orderItems.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Cant.</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderItems.map((i, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="text-sm">{i.product_name}</TableCell>
                        <TableCell className="text-sm tabular-nums">{i.quantity}</TableCell>
                        <TableCell className="text-sm tabular-nums">{formatCurrency(i.cost_price)}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{formatCurrency(i.quantity * i.cost_price)}</TableCell>
                        <TableCell>
                          <button
                            type="button"
                            aria-label="Remove product"
                            className="g-btn g-btn-ghost h-7 w-7 p-0 flex items-center justify-center text-g-bad"
                            onClick={() => setOrderItems((prev) => prev.filter((_, j) => j !== idx))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div className="flex justify-between items-center pt-2">
              <div className="text-sm text-ink-500">
                {orderItems.length} product(s) · Total:{" "}
                <span className="font-semibold text-ink-900">{formatCurrency(orderTotal)}</span>
              </div>
              <button
                type="button"
                className="g-btn g-btn-primary"
                disabled={orderItems.length === 0 || createOrder.isPending}
                onClick={() => createOrder.mutate()}
              >
                {createOrder.isPending ? "Creating..." : "Create purchase order"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
