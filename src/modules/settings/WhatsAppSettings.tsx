import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { normalizeBahrainPhone } from "@/lib/bahrain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Bot, Webhook, Save, Loader2, Wifi, CheckCircle2, XCircle, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const EVO_WEBHOOK = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/evolution-webhook`;

type DiagStep = {
  label: string;
  status: "pending" | "ok" | "fail" | "warn";
  detail?: string;
};

const statusIcon = (status: DiagStep["status"]) => {
  if (status === "ok") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (status === "fail") return <XCircle className="h-4 w-4 text-red-500 shrink-0" />;
  if (status === "warn") return <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />;
  return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />;
};

export default function WhatsAppSettings() {
  const { tenantId, branchId, branches } = useTenantContext();
  const qc = useQueryClient();
  const [selectedBranch, setSelectedBranch] = useState(branchId ?? "");
  const [instance, setInstance] = useState("");
  const [phone, setPhone] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [diagSteps, setDiagSteps] = useState<DiagStep[]>([]);
  const [diagDone, setDiagDone] = useState(false);

  const { data: config, isLoading } = useQuery({
    queryKey: ["ai-channel-config", selectedBranch],
    enabled: !!selectedBranch,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_channel_configs")
        .select("*")
        .eq("branch_id", selectedBranch)
        .eq("channel", "whatsapp")
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    if (config) {
      setInstance((config.config as any)?.evolution_instance ?? "");
      setPhone(config.phone_number ?? "");
      setIsActive(config.is_active ?? true);
    } else {
      setInstance("");
      setPhone("");
      setIsActive(true);
    }
  }, [config]);

  useEffect(() => {
    if (branchId) setSelectedBranch(branchId);
  }, [branchId]);

  const save = async () => {
    if (!instance.trim()) return toast.error("Enter the Evolution API instance name");
    if (!selectedBranch || !tenantId) return;
    setSaving(true);
    try {
      const normalizedPhone = phone.trim() ? normalizeBahrainPhone(phone) : null;
      const payload = {
        tenant_id: tenantId,
        branch_id: selectedBranch,
        channel: "whatsapp",
        phone_number: normalizedPhone,
        is_active: isActive,
        config: { evolution_instance: instance.trim() },
        updated_at: new Date().toISOString(),
      };
      const { error } = config
        ? await supabase.from("ai_channel_configs").update(payload).eq("id", config.id)
        : await supabase.from("ai_channel_configs").insert(payload);
      if (error) throw error;
      if (normalizedPhone) setPhone(normalizedPhone);
      toast.success("WhatsApp settings saved");
      qc.invalidateQueries({ queryKey: ["ai-channel-config"] });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const copyWebhook = async () => {
    await navigator.clipboard.writeText(EVO_WEBHOOK);
    toast.success("Webhook URL copied");
  };

  const runDiagnostics = async () => {
    setTesting(true);
    setDiagDone(false);
    const steps: DiagStep[] = [
      { label: "Active branch configuration", status: "pending" },
      { label: "Inbound WhatsApp webhook", status: "pending" },
      { label: "Authenticated outbound WhatsApp function", status: "pending" },
      { label: "Evolution API secrets", status: "pending" },
    ];
    setDiagSteps([...steps]);

    const update = (index: number, patch: Partial<DiagStep>) => {
      steps[index] = { ...steps[index], ...patch };
      setDiagSteps([...steps]);
    };

    try {
      const { data } = await supabase
        .from("ai_channel_configs")
        .select("id, is_active, phone_number, config")
        .eq("branch_id", selectedBranch)
        .eq("channel", "whatsapp")
        .eq("is_active", true)
        .maybeSingle();
      if (!data) update(0, { status: "fail", detail: "Save an active WhatsApp configuration for this branch first." });
      else if (!(data.config as any)?.evolution_instance) update(0, { status: "warn", detail: "Configuration exists, but the Evolution API instance name is missing." });
      else update(0, { status: "ok", detail: `Instance: ${(data.config as any).evolution_instance} · Phone: ${data.phone_number ?? "not specified"}` });
    } catch (e: any) {
      update(0, { status: "fail", detail: e.message });
    }

    try {
      const response = await fetch(EVO_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "PING_TEST", instance: "__ping__", data: {} }),
      });
      if (response.status === 200 || response.status === 404) update(1, { status: "ok", detail: `HTTP ${response.status} · function reachable` });
      else update(1, { status: "warn", detail: `HTTP ${response.status}` });
    } catch (e: any) {
      update(1, { status: "fail", detail: `Could not reach the inbound webhook: ${e.message}` });
    }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("No active session");
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-whatsapp-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ __connection_test: true, tenant_id: tenantId, branch_id: selectedBranch }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 200 && body?.diagnostics) {
        update(2, { status: "ok", detail: "Authentication and branch permissions verified" });
        const urlSet = body.diagnostics.evolution_api_url_set;
        const keySet = body.diagnostics.evolution_api_key_set;
        if (urlSet && keySet) update(3, { status: "ok", detail: "Evolution API URL and API key are configured" });
        else {
          const missing = [!urlSet && "EVOLUTION_API_URL", !keySet && "EVOLUTION_API_KEY"].filter(Boolean).join(" and ");
          update(3, { status: "fail", detail: `Missing server-side secrets: ${missing}` });
        }
      } else if (response.status === 401) {
        update(2, { status: "fail", detail: "Session authentication was rejected" });
        update(3, { status: "warn", detail: "Authentication must succeed before checking provider secrets" });
      } else if (response.status === 403) {
        update(2, { status: "fail", detail: "Your account does not have the required branch role" });
        update(3, { status: "warn", detail: "A permitted role is required before checking provider secrets" });
      } else {
        update(2, { status: "warn", detail: `Unexpected HTTP ${response.status}` });
        update(3, { status: "warn", detail: "Provider-secret status could not be confirmed" });
      }
    } catch (e: any) {
      update(2, { status: "fail", detail: e.message });
      update(3, { status: "warn", detail: "Provider-secret check did not complete" });
    }

    setDiagDone(true);
    setTesting(false);
  };

  return (
    <div className="space-y-6">
      <div className="glass p-5 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Webhook className="h-4 w-4 text-primary" />
          WhatsApp webhook URL
        </div>
        <p className="text-sm text-muted-foreground">
          Configure this URL in Evolution API as the destination for <code className="bg-muted px-1 py-0.5 rounded text-xs">MESSAGES_UPSERT</code> events.
        </p>
        <div className="flex gap-2">
          <Input readOnly value={EVO_WEBHOOK} className="font-mono text-xs" />
          <Button variant="outline" size="icon" onClick={copyWebhook} title="Copy URL">
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="glass p-5 space-y-4">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4 text-primary" />
          WhatsApp AI Agent
          {config && (
            <Badge className={config.is_active ? "bg-success text-success-foreground" : "bg-muted"}>
              {config.is_active ? "Active" : "Inactive"}
            </Badge>
          )}
        </div>

        <div className="space-y-1.5">
          <Label>Branch</Label>
          <Select value={selectedBranch} onValueChange={setSelectedBranch}>
            <SelectTrigger><SelectValue placeholder="Select branch…" /></SelectTrigger>
            <SelectContent>
              {(branches ?? []).map((branch: any) => (
                <SelectItem key={branch.id} value={branch.id}>{branch.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Evolution API instance name</Label>
              <Input placeholder="e.g. zaipos-manama" value={instance} onChange={(e) => setInstance(e.target.value)} />
              <p className="text-xs text-muted-foreground">This must exactly match the instance configured in Evolution API.</p>
            </div>

            <div className="space-y-1.5">
              <Label>Bahrain WhatsApp number (optional)</Label>
              <Input placeholder="+973 3600 0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>

            <div className="flex items-center gap-3">
              <Switch checked={isActive} onCheckedChange={setIsActive} id="wa-active" />
              <Label htmlFor="wa-active">Agent active</Label>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                Save settings
              </Button>
              <Button variant="outline" onClick={runDiagnostics} disabled={testing || !selectedBranch}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : diagDone ? <RefreshCw className="h-4 w-4 mr-2" /> : <Wifi className="h-4 w-4 mr-2" />}
                {diagDone ? "Run diagnostics again" : "Test connection"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {diagSteps.length > 0 && (
        <div className="glass p-5 space-y-3">
          <div className="font-semibold">Connection diagnostics</div>
          <div className="space-y-2">
            {diagSteps.map((step) => (
              <div key={step.label} className="flex items-start gap-2 rounded-lg border p-3">
                {statusIcon(step.status)}
                <div>
                  <div className="text-sm font-medium">{step.label}</div>
                  {step.detail && <div className="text-xs text-muted-foreground mt-0.5">{step.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
