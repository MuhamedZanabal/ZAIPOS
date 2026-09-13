import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useAuth } from "@/hooks/useAuth";
import { PageHeader } from "@/components/shared/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import { Phone, MapPin, Bike, CheckCircle2, Navigation, CreditCard, Banknote, Smartphone, QrCode, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Database } from "@/integrations/supabase/types";

import { collectionFils, formatCollectionFils } from "./collectionMoney";

type DeliveryStatus = Database["public"]["Enums"]["delivery_status"];
type PayMethod = "cash" | "card" | "transfer" | "qr";

const STATUS_META: Record<DeliveryStatus, { label: string; pillClass: string }> = {
  received:   { label: "Received",          pillClass: "g-pill-ghost" },
  preparing:  { label: "Preparing",        pillClass: "g-pill-warn" },
  ready:      { label: "Ready for pickup",pillClass: "g-pill-sky" },
  assigned:   { label: "Assigned to me",     pillClass: "g-pill-brand" },
  on_way:     { label: "On the way",         pillClass: "g-pill-brand" },
  delivered:  { label: "Delivered",         pillClass: "g-pill-ok" },
  cancelled:  { label: "Cancelled",         pillClass: "g-pill-bad" },
};

const PAY_METHODS: { id: PayMethod; label: string; icon: any }[] = [
  { id: "cash",     label: "Cash",      icon: Banknote },
  { id: "card",     label: "Card terminal",      icon: CreditCard },
  { id: "transfer", label: "Transfer", icon: Smartphone },
  { id: "qr",       label: "BenefitPay",            icon: QrCode },
];

export default function CourierDashboard() {
  const { tenantId, branchId, branches, roles } = useTenantContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const branchName = branches.find((b) => b.id === branchId)?.name ?? "—";
  const isSuperAdmin = roles.some((role) => ["super_admin", "owner", "admin", "manager", "cashier"].includes(role));

  const [payOrder, setPayOrder] = useState<any | null>(null);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [submitting, setSubmitting] = useState(false);
  const [sessionId, setSessionId] = useState("");

  // Search el employee_id del courier basado en el user_id
  const { data: employee } = useQuery({
    queryKey: ["courier-employee", user?.id, tenantId],
    enabled: !!user && !!tenantId && !isSuperAdmin,
    queryFn: async () => {
      const { data } = await supabase
        .from("employees")
        .select("id, full_name")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      return data;
    },
  });

  const { data: deliveryData, isLoading, error: deliveryError } = useQuery({
    queryKey: ["courier-orders", tenantId, branchId, user?.id],
    enabled: !!tenantId && !!branchId && !!user,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_courier_deliveries", { _tenant_id: tenantId!, _branch_id: branchId! });
      if (error) throw error;
      return data as { orders: any[]; sessions: { id: string; opened_at: string; register_name: string }[]; limit: number };
    },
  });
  const orders = useMemo(() => deliveryData?.orders ?? [], [deliveryData]);
  const sessions = deliveryData?.sessions ?? [];

  const grouped = useMemo(() => {
    const active = (orders ?? []).filter((o: any) => !["delivered", "cancelled"].includes(o.status));
    const done   = (orders ?? []).filter((o: any) => ["delivered", "cancelled"].includes(o.status));
    return { active, done };
  }, [orders]);

  if (!user || !tenantId || !branchId) {
    return <div className="p-6 h-meta">Loading...</div>;
  }

  if (deliveryError) return <div className="p-6" role="alert">Could not load authorized deliveries. {deliveryError.message}</div>;

  if (!isSuperAdmin && !employee) {
    return (
      <div className="p-6">
        <div className="glass rounded-2xl p-8 text-center h-meta">
          Your user is not linked to an employee at this branch. Ask an administrator to register you as a courier.
        </div>
      </div>
    );
  }

  const updateStatus = async (id: string, status: DeliveryStatus) => {
    const { error } = await supabase.rpc("update_delivery_status", {
      _order_id: id, _status: status, _courier_id: null,
    });
    if (error) return toast.error(error.message);
    toast.success(`Status: ${STATUS_META[status].label}`);
    qc.invalidateQueries({ queryKey: ["courier-orders"] });
  };

  const openMaps = (address: string, neighborhood?: string | null) => {
    const q = encodeURIComponent([address, neighborhood].filter(Boolean).join(", "));
    const url = `https://www.google.com/maps/search/?api=1&query=${q}`;
    if (window.electron?.openExternal) {
      void window.electron.openExternal(url).catch(() => toast.error("Could not open the map"));
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const openPay = (o: any) => {
    setPayOrder(o);
    setMethod("cash");
    setSessionId("");
  };

  const confirmPayment = async () => {
    if (!payOrder) return;
    const amount = collectionFils(payOrder.collection_total_fils);
    if (amount === null || amount <= 0n) return toast.error("Collection amount unavailable; refresh or ask a manager to reconcile this order.");
    if (!sessionId) return toast.error("Select the receiving register.");
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc("collect_delivery_payment_v2", {
        _order_id: payOrder.id,
        _method: method,
        _session_id: sessionId,
        _client_mutation_id: `delivery-collect:${payOrder.id}`,
        _reference: null,
      });
      if (error) throw error;
      toast.success(`Collection recorded · ${formatCollectionFils(amount)}`);
      setPayOrder(null);
      qc.invalidateQueries({ queryKey: ["courier-orders"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const renderCard = (o: any) => {
    const meta  = STATUS_META[o.status as DeliveryStatus];
    const total = collectionFils(o.collection_total_fils);
    return (
      <div key={o.id} className="glass rounded-2xl p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-bold leading-tight truncate text-[var(--ink-900)]">{o.customer_name || "No name"}</div>
            <div className="h-meta">{formatDate(o.created_at)}</div>
          </div>
          <span className={cn("g-pill g-pill-h22 whitespace-nowrap", meta.pillClass)}>{meta.label}</span>
        </div>

        <div className="text-sm space-y-1">
          {o.customer_phone && (
            <a href={`tel:${o.customer_phone}`} className="flex items-center gap-1.5 text-[var(--brand-600)] hover:underline">
              <Phone className="h-3.5 w-3.5" /> {o.customer_phone}
            </a>
          )}
          <button
            type="button"
            onClick={() => openMaps(o.address, o.neighborhood)}
            className="flex items-start gap-1.5 text-left hover:text-[var(--brand-600)] w-full text-[var(--ink-700)]"
          >
            <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="flex-1">{o.address}{o.neighborhood ? ` · ${o.neighborhood}` : ""}</span>
            <Navigation className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          </button>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--g-hairline)] pt-2">
          <span className="h-label">Amount to collect</span>
          <span className="h-num text-lg text-[var(--brand-600)]">{formatCollectionFils(total)}</span>
        </div>

        {o.status === "assigned" && (
          <button type="button" className="g-btn g-btn-primary w-full" onClick={() => updateStatus(o.id, "on_way")}>
            <Bike className="h-3.5 w-3.5 mr-1" /> Salir / On the way
          </button>
        )}
        {o.status === "on_way" && (
          <button type="button" className="g-btn g-btn-primary w-full" onClick={() => openPay(o)}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Collect and deliver
          </button>
        )}
        {o.status === "ready" && (
          <button type="button" className="g-btn g-btn-ghost w-full" onClick={() => updateStatus(o.id, "on_way")}>
            <Bike className="h-3.5 w-3.5 mr-1" /> Recoger y salir
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        eyebrow="OPERATIONS · DELIVERY"
        title="Courier dashboard"
        description={`${employee?.full_name ?? (isSuperAdmin ? "Super Admin" : "—")} · ${branchName}`}
      />

      <p className="h-meta">Showing the latest 100 assigned orders. Totals cover this displayed list.</p>
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="glass g-kpi">
          <div className="h-label uppercase tracking-wider">Activos</div>
          <div className="h-num text-2xl text-[var(--brand-600)]">{grouped.active.length}</div>
        </div>
        <div className="glass g-kpi">
          <div className="h-label uppercase tracking-wider">On the way</div>
          <div className="h-num text-2xl">{grouped.active.filter((o: any) => o.status === "on_way").length}</div>
        </div>
        <div className="glass g-kpi">
          <div className="h-label uppercase tracking-wider">Delivered today</div>
          <div className="h-num text-2xl text-[var(--g-ok)]">
            {grouped.done.filter((o: any) => {
              const d = new Date(o.delivered_at ?? o.updated_at);
              const t = new Date();
              return o.status === "delivered" && d.toDateString() === t.toDateString();
            }).length}
          </div>
        </div>
        <div className="glass g-kpi">
          <div className="h-label uppercase tracking-wider">Amount to collect</div>
          <div className="h-num text-2xl tabular-nums">
            {grouped.active.some((o: any) => collectionFils(o.collection_total_fils) === null) ? "Unavailable" : formatCollectionFils(grouped.active.reduce((s: bigint, o: any) => s + collectionFils(o.collection_total_fils)!, 0n))}
          </div>
        </div>
      </div>

      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">Activos ({grouped.active.length})</TabsTrigger>
          <TabsTrigger value="done">History ({grouped.done.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="active" className="mt-4">
          {isLoading ? (
            <div className="h-meta">Loading…</div>
          ) : grouped.active.length === 0 ? (
            <div className="glass rounded-2xl p-8 text-center h-meta">
              You have no assigned orders.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {grouped.active.map(renderCard)}
            </div>
          )}
        </TabsContent>

        <TabsContent value="done" className="mt-4">
          {grouped.done.length === 0 ? (
            <div className="glass rounded-2xl p-8 text-center h-meta">No history.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {grouped.done.map(renderCard)}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Payment dialog */}
      <Dialog open={!!payOrder} onOpenChange={(o) => !o && !submitting && setPayOrder(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="h-display text-lg">Charge and deliver</DialogTitle>
          </DialogHeader>
          {payOrder && (
            <div className="space-y-4">
              <div className="glass rounded-xl p-3 space-y-0.5">
                <div className="h-label">Customer</div>
                <div className="font-semibold text-[var(--ink-900)]">{payOrder.customer_name}</div>
                <div className="h-meta">{payOrder.address}</div>
              </div>
              <div className="flex items-baseline justify-between border-t border-b border-[var(--g-hairline)] py-3">
                <span className="h-label">Total received</span>
                <span className="h-num text-3xl text-[var(--brand-600)]">
                  {formatCollectionFils(collectionFils(payOrder.collection_total_fils))}
                </span>
              </div>
              <div>
                <label className="h-label" htmlFor="receiving-register">Receiving register</label>
                <select id="receiving-register" value={sessionId} onChange={(e) => setSessionId(e.target.value)} disabled={submitting} className="w-full p-2 rounded border">
                  <option value="">Select an open register</option>
                  {sessions.map((session) => <option key={session.id} value={session.id}>{session.register_name} · {session.id.slice(0, 8)} · {formatDate(session.opened_at)}</option>)}
                </select>
                <p className="h-meta">Confirm only when the payment is received and accountable to this register. Electronic payment must be verified in the provider. Fees remain separate from merchandise sales.</p>
                {sessions.length === 0 && <p role="alert">No open receiving register. Ask a cashier or manager to open one.</p>}
              </div>
              <div>
                <div className="h-label mb-2">Payment method</div>
                <div className="grid grid-cols-2 gap-2">
                  {PAY_METHODS.map((m) => {
                    const Icon = m.icon;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMethod(m.id)}
                        disabled={submitting}
                        className={cn(
                          "flex items-center gap-2 p-3 rounded-xl border-2 transition-all",
                          method === m.id
                            ? "border-[var(--brand-600)] glass-strong text-[var(--ink-900)]"
                            : "border-[var(--g-hairline)] glass text-[var(--ink-500)] hover:border-[var(--brand-600)]/40"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span className="text-sm font-medium">{m.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <button type="button" className="g-btn g-btn-ghost" onClick={() => setPayOrder(null)} disabled={submitting}>Cancel</button>
            <button type="button" className="g-btn g-btn-primary" onClick={confirmPayment} disabled={submitting || !sessionId}>
              {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Confirm delivery
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
