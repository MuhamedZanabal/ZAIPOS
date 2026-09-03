import { useState } from "react";
import { useTenantContext } from "@/hooks/useTenantContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Loader2, Mail, ShieldCheck, RefreshCcw, Send, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function SystemMaintenance() {
  const { tenantId, branchId } = useTenantContext();
  const [loading, setLoading] = useState<string | null>(null);

  const processEmailQueue = async () => {
    setLoading("email");
    try {
      const { data, error } = await supabase.functions.invoke("process-email-queue");
      if (error) throw error;
      toast.success(`Cola de emails procesada: ${data?.processed || 0} enviados`);
    } catch (err: any) {
      toast.error("Error al procesar emails: " + err.message);
    } finally {
      setLoading(null);
    }
  };

  const auditInventoryDrift = async () => {
    setLoading("inventory");
    try {
      // Este RPC asegura que todos los productos activos tengan un registro en inventory_stocks
      const { data, error } = await supabase.rpc("audit_inventory_drift", {
        _tenant_id: tenantId,
        _branch_id: branchId
      });
      if (error) throw error;
      toast.success("Inventory audit completed: stock synchronized");
    } catch (err: any) {
      toast.error("Audit error: " + err.message);
    } finally {
      setLoading(null);
    }
  };

  const testWhatsAppConnection = async () => {
    setLoading("whatsapp");
    try {
      const { data, error } = await supabase.rpc("ai_whatsapp_config_summary", {
        _branch_id: branchId
      });
      if (error) throw error;
      
      const config = data?.[0];
      if (!config || !config.is_active) {
        toast.error("WhatsApp is not configured or active for this branch");
        return;
      }

      toast.success("WhatsApp configuration loaded successfully");
    } catch (err: any) {
      toast.error("WhatsApp test error: " + err.message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Emails */}
        <div className="glass rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-brand-600">
            <Mail className="h-5 w-5" />
            <div className="g-title-15">Messaging</div>
          </div>
          <div className="h-meta">Manual processing of the pending email queue.</div>
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={processEmailQueue}
            disabled={!!loading}
          >
            {loading === "email" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Procesar Cola de Email
          </Button>
        </div>

        {/* Inventory */}
        <div className="glass rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-brand-600">
            <ShieldCheck className="h-5 w-5" />
            <div className="g-title-15">Consistencia</div>
          </div>
          <div className="h-meta">Ensures every product has valid stock records.</div>
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={auditInventoryDrift}
            disabled={!!loading}
          >
            {loading === "inventory" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
            Sincronizar Stocks
          </Button>
        </div>

        {/* WhatsApp */}
        <div className="glass rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-brand-600">
            <RefreshCcw className="h-5 w-5" />
            <div className="g-title-15">Diagnostics</div>
          </div>
          <div className="h-meta">Checks the connection status for the WhatsApp AI channel.</div>
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={testWhatsAppConnection}
            disabled={!!loading}
          >
            {loading === "whatsapp" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Test WhatsApp
          </Button>
        </div>
      </div>

      <Alert variant="destructive" className="bg-destructive/5">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Manual Mode Active</AlertTitle>
        <AlertDescription>
          Under the current operating policy, all background maintenance tasks are delegated to manual execution by an administrator.
        </AlertDescription>
      </Alert>
    </div>
  );
}
