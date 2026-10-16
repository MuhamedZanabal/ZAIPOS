import { useCallback, useEffect } from "react";
import { CloudOff, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantStore } from "@/stores/tenant";
import { useOfflineSalesStore } from "@/stores/offlineSales";
import { englishServerMessage } from "@/lib/serverMessages";

const POLL_MS = 5_000;

async function currentAuthorization() {
  const { tenantId, branchId } = useTenantStore.getState();
  if (!tenantId || !branchId) return null;
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  return accessToken ? { accessToken, tenantId, branchId } : null;
}

/**
 * Shows sales saved offline on this terminal and replays them when the local
 * ZAIPOS server is reachable again. Replays are idempotent on the server.
 */
export function OfflineSalesBanner() {
  const qc = useQueryClient();
  const { pending, failed, failures, serverReachable, set } = useOfflineSalesStore();

  const tick = useCallback(async () => {
    const bridge = window.electron;
    if (!bridge?.offlineSalesStatus || !bridge.replayOfflineSales) return;
    const authorization = await currentAuthorization();
    if (!authorization) return;
    try {
      let status = await bridge.offlineSalesStatus(authorization);
      if (status.pending > 0) {
        const summary = await bridge.replayOfflineSales(authorization);
        if (summary.committed > 0) {
          toast.success(`${summary.committed} offline sale${summary.committed === 1 ? "" : "s"} synced`);
          for (const key of ["sales", "pos-today-metrics", "dashboard-metrics", "open-session", "pos-stocks", "reports-advanced"]) {
            qc.invalidateQueries({ queryKey: [key] });
          }
        }
        status = await bridge.offlineSalesStatus(authorization);
        set({ serverReachable: summary.remaining === 0 || summary.committed > 0 });
      } else {
        set({ serverReachable: true });
      }
      set({ pending: status.pending, failed: status.failed, failures: status.failures });
    } catch {
      // Status IPC is local to this terminal; ignore transient errors and retry next tick.
    }
  }, [qc, set]);

  useEffect(() => {
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  const resolve = async (mutationId: string, action: "retry" | "discard") => {
    if (action === "discard" && !confirm("Discard this offline sale? It will not be recorded.")) return;
    const authorization = await currentAuthorization();
    if (!authorization || !window.electron?.resolveOfflineSale) return;
    await window.electron.resolveOfflineSale(mutationId, action, authorization);
    void tick();
  };

  if (pending === 0 && failed === 0) return null;

  return (
    <div role="status" aria-live="polite" data-testid="offline-sales-banner" className="w-full text-sm font-medium">
      {pending > 0 && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 text-white px-4 py-2">
          {serverReachable ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CloudOff className="h-4 w-4" />}
          <span>
            {pending} sale{pending === 1 ? "" : "s"} saved offline on this terminal ·{" "}
            {serverReachable ? "syncing…" : "will sync automatically when the ZAIPOS server is back"}
          </span>
        </div>
      )}
      {failures.map((f) => (
        <div key={f.mutationId} className="flex items-center justify-center gap-3 bg-orange-600 text-white px-4 py-2">
          <AlertTriangle className="h-4 w-4" />
          <span>Offline sale from {new Date(f.createdAt).toLocaleTimeString("en-BH")} was rejected: {englishServerMessage(f.error)}</span>
          <button type="button" className="underline" onClick={() => void resolve(f.mutationId, "retry")}>Retry</button>
          <button type="button" className="underline" onClick={() => void resolve(f.mutationId, "discard")}>Discard</button>
        </div>
      ))}
    </div>
  );
}
