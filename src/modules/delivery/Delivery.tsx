import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { PageHeader } from "@/components/shared/PageHeader";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Bike, Trash2, Phone, MapPin, Clock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatCurrency, formatDate } from "@/lib/format";
import { resolvePrice } from "@/lib/channels";
import { normalizeBahrainPhone, roundBhd } from "@/lib/bahrain";
import { Button } from "@/components/ui/button";
import type { Database } from "@/integrations/supabase/types";

type DeliveryStatus = Database["public"]["Enums"]["delivery_status"];

const STATUSES: { id: DeliveryStatus; label: string; pillClass: string }[] = [
  { id: "received", label: "Received", pillClass: "s-pill s-pill-mute" },
  { id: "preparing", label: "Preparing", pillClass: "s-pill s-pill-warn" },
  { id: "ready", label: "Ready", pillClass: "s-pill s-pill-blue" },
  { id: "assigned", label: "Assigned", pillClass: "s-pill s-pill-blue" },
  { id: "on_way", label: "On the way", pillClass: "s-pill s-pill-green" },
  { id: "delivered", label: "Delivered", pillClass: "s-pill s-pill-green" },
  { id: "cancelled", label: "Cancelled", pillClass: "s-pill s-pill-danger" },
];

const NEXT_STATUS: Record<DeliveryStatus, DeliveryStatus | null> = {
  received: "preparing",
  preparing: "ready",
  ready: "assigned",
  assigned: "on_way",
  on_way: "delivered",
  delivered: null,
  cancelled: null,
};

type LineDraft = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
};

const EMPTY_FORM = {
  customer_name: "",
  customer_phone: "",
  address: "",
  neighborhood: "",
  delivery_fee: "",
  notes: "",
};

export default function Delivery() {
  const { tenantId, branchId, branches } = useTenantContext();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: orders, isLoading } = useQuery({
    queryKey: ["delivery-orders", branchId],
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("delivery_orders")
        .select("*")
        .eq("branch_id", branchId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 20000,
  });

  const { data: couriers } = useQuery({
    queryKey: ["couriers", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("employees")
        .select("id, full_name, role")
        .eq("tenant_id", tenantId!)
        .eq("status", "active");
      return data ?? [];
    },
  });

  const { data: products } = useQuery({
    queryKey: ["delivery-products", tenantId],
    enabled: !!tenantId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id, name, price, tax_rate, sku, product_type")
        .eq("tenant_id", tenantId!)
        .eq("status", "active")
        .neq("product_type", "ingredient")
        .order("name");
      return data ?? [];
    },
  });

  const { data: channelPrices } = useQuery({
    queryKey: ["delivery-chprices", tenantId],
    enabled: !!tenantId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("product_channel_prices")
        .select("product_id, branch_id, channel, price")
        .eq("tenant_id", tenantId!);
      return data ?? [];
    },
  });

  const { data: branchProducts } = useQuery({
    queryKey: ["delivery-bprods", branchId],
    enabled: !!branchId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("branch_products")
        .select("product_id, branch_id, is_available, local_price")
        .eq("branch_id", branchId!);
      return data ?? [];
    },
  });

  const filtered = useMemo(() => {
    let list = (products ?? []).filter((product) => {
      const branchProduct = (branchProducts ?? []).find((value) => value.product_id === product.id);
      return !branchProduct || branchProduct.is_available;
    });

    if (search) {
      const normalized = search.toLowerCase();
      list = list.filter((product) =>
        product.name.toLowerCase().includes(normalized) ||
        (product.sku ?? "").toLowerCase().includes(normalized)
      );
    }
    return list.slice(0, 12);
  }, [products, branchProducts, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, any[]> = {};
    STATUSES.forEach((status) => { groups[status.id] = []; });
    (orders ?? []).forEach((order) => {
      if (groups[order.status]) groups[order.status].push(order);
    });
    return groups;
  }, [orders]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setLines([]);
    setSearch("");
  };

  const addProduct = (product: any) => {
    const price = roundBhd(resolvePrice(
      product.id,
      Number(product.price),
      branchId,
      "delivery",
      channelPrices ?? [],
      branchProducts ?? []
    ));

    setLines((previous) => {
      const existing = previous.find((line) => line.product_id === product.id);
      if (existing) {
        return previous.map((line) =>
          line.product_id === product.id ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [
        ...previous,
        {
          product_id: product.id,
          name: product.name,
          quantity: 1,
          unit_price: price,
          tax_rate: Number(product.tax_rate) || 0,
        },
      ];
    });
    setSearch("");
  };

  const total = useMemo(() => roundBhd(
    lines.reduce(
      (sum, line) => sum + line.quantity * line.unit_price * (1 + (line.tax_rate || 0) / 100),
      0
    ) + (Number(form.delivery_fee) || 0)
  ), [lines, form.delivery_fee]);

  const submit = async () => {
    if (!tenantId || !branchId) return;
    if (!form.address.trim()) return toast.error("Bahrain delivery address is required");
    if (lines.length === 0) return toast.error("Add products to the delivery");

    setSubmitting(true);
    try {
      const items = lines.map((line) => ({
        product_id: line.product_id,
        quantity: line.quantity,
        unit_price: line.unit_price,
        tax_rate: line.tax_rate,
        discount: 0,
      }));

      const rawPhone = form.customer_phone.trim();
      const { error } = await supabase.rpc("register_delivery_order", {
        _tenant_id: tenantId,
        _branch_id: branchId,
        _items: items as any,
        _customer_name: form.customer_name || null,
        _customer_phone: rawPhone ? normalizeBahrainPhone(rawPhone) : null,
        _address: form.address,
        _neighborhood: form.neighborhood || null,
        _delivery_fee: roundBhd(Number(form.delivery_fee) || 0),
        _customer_id: null,
        _notes: form.notes || null,
      });
      if (error) throw error;

      toast.success("Delivery recorded");
      qc.invalidateQueries({ queryKey: ["delivery-orders"] });
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics"] });
      setOpen(false);
      resetForm();
    } catch (error: any) {
      toast.error(error.message ?? "Could not record the delivery");
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (id: string, status: DeliveryStatus, courierId?: string | null) => {
    const { error } = await supabase.rpc("update_delivery_status", {
      _order_id: id,
      _status: status,
      _courier_id: courierId ?? null,
    });
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["delivery-orders"] });
  };

  const branchName = branches.find((branch) => branch.id === branchId)?.name ?? "—";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="OPERATIONS · DELIVERY"
        title="In-house delivery"
        description={`Bahrain delivery order board · ${branchName}`}
        actions={
          <button
            type="button"
            className="g-btn g-btn-primary"
            onClick={() => { resetForm(); setOpen(true); }}
          >
            <Plus size={15} className="mr-1" /> New delivery
          </button>
        }
      />

      {isLoading ? (
        <div className="h-meta py-6">Loading…</div>
      ) : (orders?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Bike}
          title="No deliveries"
          description="Create your first Bahrain delivery order to start using the board."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {STATUSES.filter((status) => status.id !== "cancelled").map((column) => (
            <div key={column.id} className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="h-label font-semibold uppercase tracking-wider">{column.label}</span>
                <span className="s-pill s-pill-mute">{grouped[column.id].length}</span>
              </div>

              <div className="flex flex-col gap-2 min-h-[80px]">
                {grouped[column.id].length === 0 && (
                  <div className="glass-thin rounded-xl px-3 py-6 text-center h-meta border border-dashed border-[var(--hairline)]">
                    Empty
                  </div>
                )}

                {grouped[column.id].map((order) => {
                  const next = NEXT_STATUS[order.status as DeliveryStatus];
                  return (
                    <div key={order.id} className="glass rounded-2xl p-3 flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-semibold text-sm text-ink-900 leading-tight">
                          {order.customer_name || "No name"}
                        </div>
                        <span className={column.pillClass}>{column.label}</span>
                      </div>

                      <div className="flex flex-col gap-0.5 text-xs text-ink-500">
                        {order.customer_phone && (
                          <div className="flex items-center gap-1"><Phone size={11} /> {order.customer_phone}</div>
                        )}
                        <div className="flex items-start gap-1">
                          <MapPin size={11} className="mt-0.5 shrink-0" />
                          <span>{order.address}{order.neighborhood ? ` · ${order.neighborhood}` : ""}</span>
                        </div>
                        <div className="flex items-center gap-1"><Clock size={11} /> {formatDate(order.created_at)}</div>
                      </div>

                      <div className="flex items-center justify-between text-xs pt-1 border-t border-[var(--hairline)]">
                        <span className="h-meta">Delivery fee</span>
                        <span className="tabular-nums text-ink-900 font-semibold">{formatCurrency(Number(order.delivery_fee))}</span>
                      </div>

                      {(column.id === "ready" || column.id === "assigned") && (couriers?.length ?? 0) > 0 && (
                        <Select
                          value={order.courier_id ?? undefined}
                          onValueChange={(value) => updateStatus(order.id, "assigned", value)}
                        >
                          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Assign courier" /></SelectTrigger>
                          <SelectContent>
                            {(couriers ?? []).map((courier) => (
                              <SelectItem key={courier.id} value={courier.id}>{courier.full_name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}

                      <div className="flex gap-1.5">
                        {next && (
                          <button
                            type="button"
                            className="g-btn g-btn-primary g-btn-sm flex-1"
                            onClick={() => updateStatus(order.id, next)}
                          >
                            → {STATUSES.find((status) => status.id === next)?.label}
                          </button>
                        )}
                        {order.status !== "delivered" && order.status !== "cancelled" && (
                          <button
                            type="button"
                            className="g-btn g-btn-ghost g-btn-sm text-red-500"
                            onClick={() => updateStatus(order.id, "cancelled")}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) resetForm();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>New delivery</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <Label>Customer</Label>
                <Input
                  value={form.customer_name}
                  onChange={(event) => setForm({ ...form, customer_name: event.target.value })}
                  placeholder="Customer name"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={form.customer_phone}
                  onChange={(event) => setForm({ ...form, customer_phone: event.target.value })}
                  placeholder="+973 3600 1234"
                  inputMode="tel"
                />
              </div>
              <div>
                <Label>Address</Label>
                <Input
                  value={form.address}
                  onChange={(event) => setForm({ ...form, address: event.target.value })}
                  placeholder="Building, road, block, Bahrain"
                />
              </div>
              <div>
                <Label>Area</Label>
                <Input
                  value={form.neighborhood}
                  onChange={(event) => setForm({ ...form, neighborhood: event.target.value })}
                  placeholder="Amwaj Islands, Juffair, Riffa, Seef..."
                />
              </div>
              <div>
                <Label>Delivery fee (BHD)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.delivery_fee}
                  onChange={(event) => setForm({ ...form, delivery_fee: event.target.value })}
                  placeholder="0.500"
                />
              </div>
              <div>
                <Label>Notes</Label>
                <Input
                  value={form.notes}
                  onChange={(event) => setForm({ ...form, notes: event.target.value })}
                  placeholder="Landmark or delivery instructions"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Add products</Label>
              <Input
                placeholder="Search product..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <ScrollArea className="h-44 border rounded-lg">
                  <div className="divide-y">
                    {filtered.map((product) => (
                      <button
                        type="button"
                        key={product.id}
                        onClick={() => addProduct(product)}
                        className="w-full text-left px-3 py-2 hover:bg-muted/40 flex items-center justify-between text-sm"
                      >
                        <span>{product.name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatCurrency(resolvePrice(
                            product.id,
                            Number(product.price),
                            branchId,
                            "delivery",
                            channelPrices ?? [],
                            branchProducts ?? []
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              )}

              <div className="glass rounded-2xl p-3">
                {lines.length === 0 ? (
                  <div className="h-meta py-3 text-center">No items yet</div>
                ) : (
                  <div className="space-y-2 max-h-44 overflow-auto">
                    {lines.map((line) => (
                      <div key={line.product_id} className="flex items-center gap-2 text-sm">
                        <Input
                          type="number"
                          min="1"
                          value={line.quantity}
                          onChange={(event) => {
                            const quantity = Math.max(1, Number(event.target.value) || 1);
                            setLines((previous) => previous.map((value) =>
                              value.product_id === line.product_id ? { ...value, quantity } : value
                            ));
                          }}
                          className="w-16 h-8 text-center tabular-nums"
                        />
                        <div className="flex-1 truncate">{line.name}</div>
                        <div className="tabular-nums w-24 text-right">
                          {formatCurrency(roundBhd(line.unit_price * line.quantity * (1 + (line.tax_rate || 0) / 100)))}
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setLines((previous) => previous.filter((value) => value.product_id !== line.product_id))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 pt-3 border-t border-[var(--hairline)] flex justify-between font-bold">
                  <span>Total</span>
                  <span>{formatCurrency(total)}</span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting || lines.length === 0}>Record delivery</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
