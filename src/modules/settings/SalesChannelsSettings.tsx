import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Copy, RefreshCw, PlugZap, BookOpen, Store, UtensilsCrossed, CarFront } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/format";
import type { Database } from "@/integrations/supabase/types";

type SalesChannel = Database["public"]["Enums"]["sales_channel"];

const RAPPI_WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/rappi-webhook`;

export default function SalesChannelsSettings() {
  const { tenantId, branchId, branches, hasRole } = useTenantContext();
  const qc = useQueryClient();
  const isSuperAdmin = hasRole("super_admin");

  const [activeChannels, setActiveChannels] = useState<SalesChannel[]>([]);
  const [savingChannels, setSavingChannels] = useState(false);

  // Rappi State
  const [rappiStoreId, setRappiStoreId] = useState("");
  const [rappiAutoAccept, setRappiAutoAccept] = useState(false);
  const [rappiPrepTime, setRappiPrepTime] = useState(15);
  const [rappiStatus, setRappiStatus] = useState<"active" | "paused">("active");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: tenant, isLoading: loadingTenant } = useQuery({
    queryKey: ["tenant-channels", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("active_channels")
        .eq("id", tenantId!)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (tenant?.active_channels) {
      setActiveChannels(tenant.active_channels);
    } else {
      setActiveChannels(["pos", "qr", "delivery", "tables"]);
    }
  }, [tenant]);

  const updateChannelsMutation = useMutation({
    mutationFn: async (newChannels: SalesChannel[]) => {
      const { error } = await supabase
        .from("tenants")
        .update({ active_channels: newChannels })
        .eq("id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Canales de venta actualizados");
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      qc.invalidateQueries();
    },
    onError: (e: any) => toast.error(e.message),
    onSettled: () => setSavingChannels(false),
  });

  const toggleChannel = (channel: SalesChannel, enabled: boolean) => {
    if (!isSuperAdmin) return toast.error("Only a super administrator can change this.");
    setSavingChannels(true);
    let updated = [...activeChannels];
    if (enabled) {
      if (!updated.includes(channel)) updated.push(channel);
    } else {
      updated = updated.filter((c) => c !== channel);
    }
    setActiveChannels(updated);
    updateChannelsMutation.mutate(updated);
  };

  const { data: rappiInteg, isLoading: loadingRappi } = useQuery({
    queryKey: ["rappi-integration", branchId],
    enabled: !!branchId && activeChannels.includes("rappi"),
    queryFn: async () => {
      const { data } = await supabase
        .from("rappi_integrations")
        .select("*")
        .eq("branch_id", branchId!)
        .maybeSingle();
      return data;
    },
  });

  const { data: rappiLogs } = useQuery({
    queryKey: ["rappi-logs", branchId],
    enabled: !!branchId && activeChannels.includes("rappi"),
    refetchInterval: 10000,
    queryFn: async () => {
      const { data } = await supabase
        .from("rappi_webhook_logs")
        .select("*")
        .or(`branch_id.eq.${branchId},branch_id.is.null`)
        .order("created_at", { ascending: false })
        .limit(10);
      return data ?? [];
    },
  });

  useEffect(() => {
    if (rappiInteg) {
      setRappiStoreId(rappiInteg.store_id ?? "");
      setRappiAutoAccept(!!rappiInteg.auto_accept);
      setRappiPrepTime(rappiInteg.prep_time_min ?? 15);
      setRappiStatus((rappiInteg.status as any) ?? "active");
    } else {
      setRappiStoreId(""); setRappiAutoAccept(false); setRappiPrepTime(15); setRappiStatus("active");
    }
  }, [rappiInteg]);

  const branchName = branches.find((b) => b.id === branchId)?.name ?? "—";

  const saveRappi = async () => {
    if (!tenantId || !branchId) return;
    if (!rappiStoreId.trim()) return toast.error("Enter the Rappi Store ID");
    setBusy("saveRappi");
    try {
      const payload = {
        tenant_id: tenantId,
        branch_id: branchId,
        store_id: rappiStoreId.trim(),
        auto_accept: rappiAutoAccept,
        prep_time_min: rappiPrepTime,
        status: rappiStatus,
      };
      const { error } = rappiInteg
        ? await supabase.from("rappi_integrations").update(payload).eq("id", rappiInteg.id)
        : await supabase.from("rappi_integrations").insert(payload);
      if (error) throw error;
      toast.success("Rappi settings saved");
      qc.invalidateQueries({ queryKey: ["rappi-integration"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally { setBusy(null); }
  };

  const testRappi = async () => {
    if (!branchId) return;
    setBusy("testRappi");
    try {
      const { data, error } = await supabase.functions.invoke("rappi-test-connection", {
        body: { branch_id: branchId, store_id: rappiStoreId || rappiInteg?.store_id },
      });
      if (error) throw error;
      if (data?.ok) toast.success("Rappi connection OK");
      else toast.error(`Failed: ${data?.error ?? "check credentials"}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };

  const syncRappiMenu = async () => {
    if (!branchId) return;
    setBusy("syncRappi");
    try {
      const { data, error } = await supabase.functions.invoke("rappi-sync-menu", {
        body: { branch_id: branchId },
      });
      if (error) throw error;
      if (data?.ok) toast.success(`Menu sent · ${data.items} items`);
      else toast.error(`Error: ${data?.error ?? "could not send"}`);
      qc.invalidateQueries({ queryKey: ["rappi-integration"] });
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };

  const copyWebhook = async () => {
    await navigator.clipboard.writeText(RAPPI_WEBHOOK_URL);
    toast.success("URL del webhook copiada");
  };

  if (loadingTenant) return <div className="h-meta">Loading...</div>;

  return (
    <div className="space-y-8">
      {/* GLOBAL CHANNELS TOGGLES */}
      <div className="glass p-6 rounded-2xl space-y-6">
        <div>
          <h2 className="font-bold flex items-center gap-2 text-ink-900">
            <Store className="h-5 w-5 text-brand-600" />
            Canales de Venta
          </h2>
          <p className="h-meta mt-1">
            Enable or disable the sales channels available for this business. Disabled channels will not appear in the Point of Sale or elsewhere in the system. (Super Admin only)
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* POS — always on */}
          <div className="glass-thin rounded-xl p-4 flex flex-col gap-3 opacity-70">
            <div className="flex items-center justify-between">
              <div className="font-semibold flex items-center gap-2 text-ink-900">
                <Store className="h-4 w-4" /> Physical POS
              </div>
              <Switch checked disabled />
            </div>
            <p className="h-meta">Default physical point of sale (always active).</p>
          </div>

          {(
            [
              { key: "tables" as SalesChannel, label: "Tables", icon: <UtensilsCrossed className="h-4 w-4" />, desc: "On-site table sales and management." },
              { key: "delivery" as SalesChannel, label: "In-house Delivery", icon: <CarFront className="h-4 w-4" />, desc: "Manage in-house deliveries with couriers. Supports transfer or cash-on-delivery payments." },
              { key: "rappi" as SalesChannel, label: "Rappi", icon: <PlugZap className="h-4 w-4 text-orange-500" />, desc: "Direct integration with Rappi orders." },
              { key: "didi" as SalesChannel, label: "Didi Food", icon: <PlugZap className="h-4 w-4 text-orange-500" />, desc: "Enable the Didi Food sales channel." },
              { key: "uber" as SalesChannel, label: "Uber Eats", icon: <PlugZap className="h-4 w-4 text-green-500" />, desc: "Enable the Uber Eats sales channel." },
            ] as { key: SalesChannel; label: string; icon: React.ReactNode; desc: string }[]
          ).map(({ key, label, icon, desc }) => {
            const active = activeChannels.includes(key);
            return (
              <div key={key} className={`glass-thin rounded-xl p-4 flex flex-col gap-3 transition-opacity ${active ? "" : "opacity-60"}`}>
                <div className="flex items-center justify-between">
                  <div className="font-semibold flex items-center gap-2 text-ink-900">{icon} {label}</div>
                  <Switch
                    disabled={!isSuperAdmin || savingChannels}
                    checked={active}
                    onCheckedChange={(c) => toggleChannel(key, c)}
                  />
                </div>
                <p className="h-meta">{desc}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* RAPPI CONFIGURATION */}
      {activeChannels.includes("rappi") && (
        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <div className="glass p-6 rounded-2xl space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <PlugZap className="h-5 w-5 text-orange-500" />
                <h2 className="font-bold text-ink-900">Rappi Settings</h2>
                {rappiInteg && (
                  <span className={`g-pill g-pill-h22 ml-2 ${rappiStatus === "active" ? "g-pill-ok" : "g-pill-ghost"}`}>
                    {rappiStatus === "active" ? "Activa" : "Pausada"}
                  </span>
                )}
              </div>
              <p className="h-meta mt-1">
                Branch: <strong>{branchName}</strong>. Each branch uses its own Rappi Partners Store ID.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Store ID (Rappi)</Label>
                <Input value={rappiStoreId} onChange={(e) => setRappiStoreId(e.target.value)} placeholder="Ej. 900123" />
              </div>
              <div className="space-y-1.5">
                <Label>Preparation time (min)</Label>
                <Input
                  type="number" min="1" max="120"
                  value={rappiPrepTime}
                  onChange={(e) => setRappiPrepTime(Number(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={rappiStatus} onValueChange={(v) => setRappiStatus(v as "active" | "paused")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Activa</SelectItem>
                    <SelectItem value="paused">Pausada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between border border-black/5 rounded-lg px-3 h-10 mt-6">
                <Label className="cursor-pointer">Auto-aceptar pedidos</Label>
                <Switch checked={rappiAutoAccept} onCheckedChange={setRappiAutoAccept} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="g-btn g-btn-primary" onClick={saveRappi} disabled={busy === "saveRappi"}>
                {busy === "saveRappi" && <Loader2 className="h-4 w-4 animate-spin" />} Save
              </button>
              <button type="button" className="g-btn g-btn-ghost" onClick={testRappi} disabled={busy === "testRappi"}>
                {busy === "testRappi" && <Loader2 className="h-4 w-4 animate-spin" />} Test connection
              </button>
              <button type="button" className="g-btn g-btn-ghost" onClick={syncRappiMenu} disabled={busy === "syncRappi" || !rappiInteg}>
                {busy === "syncRappi" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync menu
              </button>
              <a
                href="https://dev-portal.rappi.com/api/es/" target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm ml-auto h-label text-brand-600 hover:underline"
              >
                <BookOpen className="h-4 w-4" /> Documentation
              </a>
            </div>

            {rappiInteg?.last_menu_sync_at && (
              <p className="h-meta">Last menu sync: {formatDate(rappiInteg.last_menu_sync_at)}</p>
            )}

            <div className="border-t border-black/5 pt-4 space-y-2">
              <p className="h-label uppercase tracking-wider">URL del Webhook</p>
              <div className="flex gap-2">
                <Input readOnly value={RAPPI_WEBHOOK_URL} className="font-mono text-xs" />
                <button type="button" className="g-btn g-btn-ghost h-10 w-10 p-0 flex items-center justify-center" title="Copiar URL webhook" onClick={copyWebhook}>
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <p className="h-meta">
                Paste this URL into the Rappi Partner Portal as the event destination (new orders, status changes).
              </p>
            </div>
          </div>

          <div className="glass p-4 rounded-2xl">
            <p className="font-semibold text-sm text-ink-900 mb-3">Latest received events</p>
            {(rappiLogs ?? []).length === 0 ? (
              <p className="h-meta">No events yet.</p>
            ) : (
              <div className="space-y-2 max-h-[480px] overflow-auto">
                {rappiLogs!.map((l) => (
                  <div key={l.id} className="glass-thin rounded-lg p-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-ink-900">{l.event_type}</span>
                      <span className={`g-pill g-pill-h18 ${l.status === "error" ? "g-pill-bad" : "g-pill-ghost"}`}>
                        {l.status}
                      </span>
                    </div>
                    <div className="h-meta">{formatDate(l.created_at)}</div>
                    {l.rappi_order_id && <div className="h-meta">Order: {l.rappi_order_id}</div>}
                    {l.error && <div className="text-red-500 truncate">{l.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
