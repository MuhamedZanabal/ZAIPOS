import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { normalizeBusinessMode } from "@/lib/business-modes";
import { SetupWizard } from "@/components/setup/SetupWizard";
import { FIRST_SALE_GUIDE_KEY, SETUP_DEFERRED_KEY } from "@/hooks/useSetupInProgress";
import { ensureTerminalActivated } from "@/lib/terminalActivation";
import { applyStarterCatalog, createStaff, savePaymentsAndReceipt, setSetupStatus } from "@/lib/setupApply";
import {
  FIRST_IN_APP_STEP,
  WIZARD_STEPS,
  clearWizard,
  initialWizardState,
  loadWizard,
  readSetupStatus,
  starterCatalog,
  type WizardState,
} from "@/lib/setupWizard";


export default function Setup() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { tenantId, branchId } = useTenantContext();
  const { data: tenant, isLoading, isFetchedAfterMount } = useQuery({
    queryKey: ["setup-tenant", tenantId],
    staleTime: 0,
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("tenants").select("name, tax_rate, receipt_config, business_mode").eq("id", tenantId!).maybeSingle();
      if (error) throw error;
      return data as { name: string; tax_rate: number; receipt_config: Record<string, unknown> | null; business_mode: string } | null;
    },
  });

  // Resume from this device's draft, or rebuild one from the business record.
  const initial = useMemo<WizardState | null>(() => {
    if (!tenant) return null;
    // Read the type from the business record itself: the tenant context may still be loading.
    const businessMode = normalizeBusinessMode(tenant.business_mode);
    const saved = loadWizard();
    const status = readSetupStatus(tenant.receipt_config);
    const base = saved && saved.mode === businessMode ? saved : {
      ...initialWizardState(),
      mode: businessMode,
      catalog: { useSamples: true, items: starterCatalog(businessMode) },
    };
    const rc = tenant.receipt_config ?? {};
    return {
      ...base,
      basics: { ...base.basics, businessName: tenant.name, vatRate: Number(tenant.tax_rate ?? 10), trn: String(rc.trn ?? base.basics.trn ?? "") },
      step: Math.max(FIRST_IN_APP_STEP, saved?.step ?? status?.step ?? FIRST_IN_APP_STEP),
    };
  }, [tenant]);

  // Wait for a fresh read: a persisted cache entry must not pick the business type.
  if (isLoading || !isFetchedAfterMount || !initial || !tenantId || !branchId) {
    return <div className="grid min-h-screen place-items-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  const saveStep = async (step: number, state: WizardState): Promise<WizardState> => {
    const key = WIZARD_STEPS[step].key;
    if (key === "catalog") {
      // The shop computer needs to be an activated terminal for opening stock and the first sale.
      await ensureTerminalActivated();
    }
    if (key === "catalog" && state.catalog.useSamples) {
      await applyStarterCatalog(tenantId, branchId, state.basics.vatRate, state.catalog.items);
      await qc.invalidateQueries({ queryKey: ["products"] });
    }
    if (key === "payments") {
      await savePaymentsAndReceipt(tenantId, state, step + 1);
      return state;
    }
    if (key === "staff") {
      const pending = state.staff.filter((member) => !member.created);
      await createStaff(tenantId, branchId, pending);
      state = { ...state, staff: state.staff.map((member) => ({ ...member, password: "", created: true })) };
    }
    await setSetupStatus(tenantId, { status: "in_progress", step: step + 1 });
    return state;
  };

  const finish = async () => {
    await setSetupStatus(tenantId, { status: "completed", step: WIZARD_STEPS.length - 1 });
    clearWizard();
    localStorage.setItem(FIRST_SALE_GUIDE_KEY, "1");
    await qc.invalidateQueries({ queryKey: ["setup-status", tenantId] });
    await qc.invalidateQueries({ queryKey: ["pos-tenant", tenantId] });
    navigate("/pos", { replace: true });
  };

  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 p-4 sm:p-8">
      <SetupWizard
        initial={initial}
        onSaveStep={saveStep}
        onFinish={finish}
        onExit={() => { sessionStorage.setItem(SETUP_DEFERRED_KEY, "1"); navigate("/dashboard"); }}
      />
    </main>
  );
}
