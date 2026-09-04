import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { PageHeader } from "@/components/shared/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Smartphone, Trash2, ClipboardList, MapPin, User, Clock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/EmptyState";
import { formatCurrency, formatDate } from "@/lib/format";
import { channelLabel, resolvePrice, type SalesChannel } from "@/lib/channels";
import { roundBhd } from "@/lib/bahrain";

type LineDraft = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
};

type OrderItem = {
  id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  line_total: number;
};

type DigitalOrder = {
  id: string;
  channel: string;
  external_order_number: string | null;
  gross_total: number;
  platform_commission: number;
  net_total: number;
  status: string;
  external_status: string | null;
  delivery_address: string | null;
  notes: string | null;
  sale_id: string | null;
  table_id: string | null;
  created_at: string;
  digital_order_items: OrderItem[];
  tables: { name: string } | null;
};

const PLATFORMS: { value: SalesChannel; label: string }[] = [
  { value: "talabat", label: "Talabat" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "delivery", label: "In-house Delivery" },
];

const CHANNEL_PILL: Record<string, string> = {
  talabat: "s-pill s-pill-warn",
  whatsapp: "s-pill s-pill-green",
  delivery: "s-pill s-pill-blue",
};

function OrderModal({
  order,
  onClose,
  onConfirm,
}: {
  order: DigitalOrder;
  onClose: () => void;
  onConfirm: (id: string) => void;
}) {
  const notesParts = (order.notes ?? "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);

  const minutesAgo = Math.max(0, Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000));
  const timeLabel = minutesAgo < 60
    ? `${minutesAgo} min ago`
    : `${Math.floor(minutesAgo / 60)}h ${minutesAgo % 60}m ago`;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md p-0 overflow-hidden">
        <div className="px-5 py-4 flex items-start justify-between border-b border-[var(--hairline)]">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`${CHANNEL_PILL[order.channel] ?? "s-pill s-pill-mute"}`}>
                {channelLabel(order.channel)}
              </span>
              <span className="font-bold text-base text-ink-900">
                #{order.external_order_number ?? "—"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 h-meta">
              <Clock size={11} />
              <span>{formatDate(order.created_at)} · {timeLabel}</span>
            </div>
          </div>
          {order.external_status && (
            <span className="s-pill s-pill-mute capitalize">{order.external_status}</span>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <div className="flex items-center gap-1.5 h-meta uppercase tracking-wider mb-2">
              <ClipboardList size={12} /> Order items
            </div>
            {order.digital_order_items?.length > 0 ? (
              <div className="space-y-1.5">
                {order.digital_order_items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg orb text-xs font-bold">
                        {item.quantity}
                      </span>
                      <span className="font-medium text-ink-900">{item.product_name}</span>
                    </div>
                    <span className="tabular-nums h-meta">{formatCurrency(Number(item.line_total))}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="h-meta">No items recorded</p>
            )}
          </div>

          <div className="border-t border-[var(--hairline)]" />

          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-ink-500">
              <span>Gross total</span>
              <span className="tabular-nums">{formatCurrency(Number(order.gross_total))}</span>
            </div>
            {Number(order.platform_commission) > 0 && (
              <div className="flex justify-between text-red-500">
                <span>Platform commission</span>
                <span className="tabular-nums">−{formatCurrency(Number(order.platform_commission))}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-base pt-1 border-t border-[var(--hairline)]">
              <span className="text-ink-900">Net total</span>
              <span className="tabular-nums text-brand-600">{formatCurrency(Number(order.net_total))}</span>
            </div>
          </div>

          {order.delivery_address && (
            <>
              <div className="border-t border-[var(--hairline)]" />
              <div>
                <div className="flex items-center gap-1.5 h-meta uppercase tracking-wider mb-2">
                  <MapPin size={12} /> Delivery address
                </div>
                <p className="text-sm font-medium glass-thin rounded-xl px-3 py-2">
                  {order.delivery_address}
                </p>
              </div>
            </>
          )}

          {notesParts.length > 0 && (
            <>
              <div className="border-t border-[var(--hairline)]" />
              <div>
                <div className="flex items-center gap-1.5 h-meta uppercase tracking-wider mb-2">
                  <User size={12} /> Order notes
                </div>
                <div className="space-y-1">
                  {notesParts.map((part) => (
                    <p key={part} className="text-sm text-ink-500">{part}</p>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--hairline)] flex gap-2 justify-end">
          <button type="button" className="g-btn g-btn-ghost g-btn-sm" onClick={onClose}>
            Close
          </button>
          {!order.sale_id && order.status !== "cancelled" && (
            <button
              type="button"
              className="g-btn g-btn-primary g-btn-sm"
              onClick={() => {
                onConfirm(order.id);
                onClose();
              }}
            >
              Confirm sale
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function DigitalOrders() {
  const { tenantId, branchId, branches } = useTenantContext();
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<SalesChannel>("talabat");
  const [externalNo, setExternalNo] = useState("");
  const [commission, setCommission] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<DigitalOrder | null>(null);

  const { data: orders, isLoading } = useQuery({
    queryKey: ["digital-orders", branchId],
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("digital_orders")
        .select("*, digital_order_items(*), tables(name)")
        .eq("branch_id", branchId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as DigitalOrder[];
    },
  });

  useEffect(() => {
    if (!branchId) return;
    const realtime = supabase
      .channel(`digital-orders-${branchId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "digital_orders", filter: `branch_id=eq.${branchId}` },
        () => qc.invalidateQueries({ queryKey: ["digital-orders", branchId] })
      )
      .subscribe();

    return () => {
      supabase.removeChannel(realtime);
    };
  }, [branchId, qc]);

  const confirmOrder = async (orderId: string) => {
    try {
      const { error } = await supabase.rpc("confirm_digital_order" as any, { _order_id: orderId });
      if (error) throw error;
      toast.success("Order confirmed as a sale");
      qc.invalidateQueries({ queryKey: ["digital-orders"] });
      qc.invalidateQueries({ queryKey: ["sales"] });
      qc.invalidateQueries({ queryKey: ["pos-stocks"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics"] });
    } catch (error: any) {
      toast.error(error.message ?? "Could not confirm the order");
    }
  };

  const { data: products } = useQuery({
    queryKey: ["digital-products", tenantId],
    enabled: !!tenantId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id, name, price, tax_rate, product_type, sku")
        .eq("tenant_id", tenantId!)
        .eq("status", "active")
        .neq("product_type", "ingredient")
        .order("name");
      return data ?? [];
    },
  });

  const { data: channelPrices } = useQuery({
    queryKey: ["digital-chprices", tenantId],
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
    queryKey: ["digital-bprods", branchId],
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
      const normalizedSearch = search.toLowerCase();
      list = list.filter(
        (product) => product.name.toLowerCase().includes(normalizedSearch) ||
          (product.sku ?? "").toLowerCase().includes(normalizedSearch)
      );
    }

    return list.slice(0, 12);
  }, [products, branchProducts, search]);

  const resetForm = () => {
    setChannel("talabat");
    setExternalNo("");
    setCommission("");
    setNotes("");
    setLines([]);
    setSearch("");
  };

  const addProduct = (product: any) => {
    const price = roundBhd(
      resolvePrice(
        product.id,
        Number(product.price),
        branchId,
        channel,
        channelPrices ?? [],
        branchProducts ?? []
      )
    );

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

  const grossTotal = useMemo(
    () => roundBhd(
      lines.reduce(
        (sum, line) => sum + line.quantity * line.unit_price * (1 + (line.tax_rate || 0) / 100),
        0
      )
    ),
    [lines]
  );
  const commissionNum = roundBhd(Number(commission) || 0);
  const netTotal = roundBhd(Math.max(0, grossTotal - commissionNum));

  const submit = async () => {
    if (!tenantId || !branchId) return;
    if (lines.length === 0) return toast.error("Add products to the order");

    setSubmitting(true);
    try {
      const itemsPayload = lines.map((line) => ({
        product_id: line.product_id,
        quantity: line.quantity,
        unit_price: line.unit_price,
        tax_rate: line.tax_rate,
        discount: 0,
      }));

      const { error } = await supabase.rpc("register_digital_order" as any, {
        _tenant_id: tenantId,
        _branch_id: branchId,
        _channel: channel,
        _external_no: externalNo || null,
        _items: itemsPayload,
        _commission: commissionNum,
        _notes: notes || null,
      });
      if (error) throw error;

      toast.success(`${channelLabel(channel)} order recorded`);
      qc.invalidateQueries({ queryKey: ["digital-orders"] });
      qc.invalidateQueries({ queryKey: ["dashboard-metrics"] });
      setOpen(false);
      resetForm();
    } catch (error: any) {
      toast.error(error.message ?? "Could not record the digital order");
    } finally {
      setSubmitting(false);
    }
  };

  const branchName = branches.find((branch) => branch.id === branchId)?.name ?? "—";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="OPERATIONS · DIGITAL CHANNELS"
        title="Digital orders"
        description={`Talabat, WhatsApp, and in-house delivery · ${branchName}`}
        actions={
          <button
            type="button"
            className="g-btn g-btn-primary"
            onClick={() => {
              resetForm();
              setOpen(true);
            }}
          >
            <Plus size={15} className="mr-1" /> New order
          </button>
        }
      />

      {isLoading ? (
        <div className="h-meta py-6">Loading…</div>
      ) : !orders || orders.length === 0 ? (
        <EmptyState
          icon={Smartphone}
          title="No digital orders"
          description="Record Talabat, WhatsApp, or in-house delivery orders to track commissions and net sales."
        />
      ) : (
        <div className="glass rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[110px_140px_110px_1fr_110px_110px_150px] px-5 py-3 border-b border-[var(--hairline)] text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            <div>Channel</div>
            <div>Order</div>
            <div>Status</div>
            <div className="text-right">Gross</div>
            <div className="text-right">Commission</div>
            <div className="text-right">Net</div>
            <div className="text-right">Actions</div>
          </div>

          <div className="divide-y divide-[var(--hairline)]">
            {orders.map((order) => {
              const itemCount = order.digital_order_items?.length ?? 0;
              return (
                <div
                  key={order.id}
                  className="grid grid-cols-[110px_140px_110px_1fr_110px_110px_150px] items-center px-5 py-3 text-sm gap-2 hover:bg-white/5 transition-colors"
                >
                  <span className={`${CHANNEL_PILL[order.channel] ?? "s-pill s-pill-mute"}`}>
                    {channelLabel(order.channel)}
                  </span>
                  <div>
                    <div className="font-medium text-ink-900">#{order.external_order_number ?? "—"}</div>
                    <div className="h-meta">{formatDate(order.created_at)}</div>
                  </div>
                  <div>
                    {order.external_status
                      ? <span className="s-pill s-pill-mute capitalize">{order.external_status}</span>
                      : <span className="h-meta capitalize">{order.status || "—"}</span>}
                  </div>
                  <div className="text-right tabular-nums text-ink-900">{formatCurrency(Number(order.gross_total))}</div>
                  <div className="text-right tabular-nums text-red-500">−{formatCurrency(Number(order.platform_commission))}</div>
                  <div className="text-right tabular-nums font-semibold text-ink-900">{formatCurrency(Number(order.net_total))}</div>
                  <div className="flex justify-end gap-1 flex-wrap">
                    <button
                      type="button"
                      className="g-btn g-btn-ghost g-btn-sm gap-1"
                      onClick={() => setSelectedOrder(order)}
                    >
                      <ClipboardList size={12} /> Details{itemCount > 0 ? ` (${itemCount})` : ""}
                    </button>
                    {!order.sale_id && order.status !== "cancelled" && (
                      <button
                        type="button"
                        className="g-btn g-btn-primary g-btn-sm"
                        onClick={() => confirmOrder(order.id)}
                      >
                        Confirm
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedOrder && (
        <OrderModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onConfirm={confirmOrder}
        />
      )}

      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) resetForm();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>New digital order</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <Label>Channel</Label>
                <Select value={channel} onValueChange={(value) => setChannel(value as SalesChannel)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map((platform) => (
                      <SelectItem key={platform.value} value={platform.value}>{platform.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>External order number</Label>
                <Input
                  value={externalNo}
                  onChange={(event) => setExternalNo(event.target.value)}
                  placeholder="e.g. TLB-12345"
                />
              </div>

              <div>
                <Label>Platform commission (BHD)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={commission}
                  onChange={(event) => setCommission(event.target.value)}
                  placeholder="0.000"
                />
              </div>

              <div>
                <Label>Notes</Label>
                <Input
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Delivery area, customer note, or marketplace reference"
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
                          {formatCurrency(
                            resolvePrice(
                              product.id,
                              Number(product.price),
                              branchId,
                              channel,
                              channelPrices ?? [],
                              branchProducts ?? []
                            )
                          )}
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

                <div className="mt-3 pt-3 border-t border-[var(--hairline)] space-y-1 text-sm">
                  <div className="flex justify-between text-ink-500">
                    <span>Gross total</span>
                    <span className="tabular-nums">{formatCurrency(grossTotal)}</span>
                  </div>
                  <div className="flex justify-between text-red-500">
                    <span>Commission</span>
                    <span className="tabular-nums">−{formatCurrency(commissionNum)}</span>
                  </div>
                  <div className="flex justify-between font-bold text-base pt-1 border-t border-[var(--hairline)]">
                    <span className="text-ink-900">Estimated net</span>
                    <span className="tabular-nums text-brand-600">{formatCurrency(netTotal)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Marketplace status actions are intentionally local-only until a documented Talabat partner API contract and credentials are configured.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={submitting || lines.length === 0}>Record order</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
