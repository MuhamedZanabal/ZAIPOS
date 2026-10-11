import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { signOutFully } from "@/lib/signOut";
import { SetupWizard } from "@/components/setup/SetupWizard";
import { saveBasics } from "@/lib/setupApply";
import { FIRST_IN_APP_STEP, saveWizard, type WizardState } from "@/lib/setupWizard";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useTenantStore } from "@/stores/tenant";
import { useQueryClient } from "@tanstack/react-query";
import { GearMark } from "@/components/shared/GearMark";

export default function Onboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { setTenant, setBranch } = useTenantStore();

  useEffect(() => {
    document.title = "Business Setup | ZAIPOS";
  }, []);

  const [checking, setChecking] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [tenantOptions, setTenantOptions] = useState<
    Array<{ tenant_id: string; branch_id: string | null; role: string; tenants: { name: string } | null }>
  >([]);


  const enterTenant = async (tenantId: string, branchId: string | null) => {
    setTenant(tenantId);
    if (branchId) setBranch(branchId);
    else {
      const { data: br } = await supabase
        .from("branches").select("id")
        .eq("tenant_id", tenantId).eq("status", "active")
        .order("name").limit(1).maybeSingle();
      setBranch(br?.id ?? null);
    }
    await qc.invalidateQueries({ queryKey: ["my-roles"] });
    navigate("/dashboard", { replace: true });
  };

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { data: myRoles } = await supabase
          .from("user_roles")
          .select("tenant_id, branch_id, role, tenants(name)")
          .eq("user_id", user.id);

        if (myRoles && myRoles.length > 0) {
          if (myRoles.length === 1) {
            await enterTenant(myRoles[0].tenant_id, myRoles[0].branch_id);
            return;
          }
          setTenantOptions(myRoles as any);
          setChecking(false);
          return;
        }

        const { data: anyTenant } = await supabase
          .from("tenants").select("id").limit(1).maybeSingle();

        if (anyTenant) { setAccessDenied(true); }
        else { setNeedsBootstrap(true); }
      } catch { setNeedsBootstrap(true); }
      finally { setChecking(false); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const createBusiness = async (state: WizardState) => {
    const { data, error } = await supabase.rpc("bootstrap_tenant_v2" as any, {
      _business_name: state.basics.businessName.trim(),
      _branch_name: state.basics.branchName.trim(),
      _tax_rate: state.basics.vatRate,
      _business_mode: state.mode,
    });
    if (error) throw error;
    const bootstrap = Array.isArray(data) ? data[0] : data;
    if (!bootstrap?.tenant_id || !bootstrap?.branch_id) throw new Error("Bootstrap did not return tenant/branch");
    setTenant(bootstrap.tenant_id);
    setBranch(bootstrap.branch_id);
    await saveBasics(bootstrap.tenant_id, state, FIRST_IN_APP_STEP);
    saveWizard({ ...state, step: FIRST_IN_APP_STEP });
    await qc.invalidateQueries({ queryKey: ["my-roles"] });
    toast.success("Business created. Let's finish setting it up.");
    navigate("/setup", { replace: true });
  };

  if (checking) {
    return (
      <div className="g-onboarding-root">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--ink-400)" }} />
      </div>
    );
  }

  if (tenantOptions.length > 0) {
    return (
      <div className="g-onboarding-root">
        <div className="glass g-onboarding-card">
          <div className="flex items-center gap-3 mb-5">
            <GearMark size={36} />
            <div>
              <div className="h-label g-auth-eyebrow mb-1">MULTIPLE ACCESS</div>
              <div className="h-display g-auth-title">Which business do you work in?</div>
              <div className="h-meta mt-0.5">You have access to several businesses.</div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {tenantOptions.map((opt) => (
              <button
                key={opt.tenant_id}
                type="button"
                className="glass-thin g-onboarding-tenant-btn text-left"
                onClick={() => enterTenant(opt.tenant_id, opt.branch_id)}
              >
                <div className="g-onboarding-tenant-name">
                  {opt.tenants?.name ?? opt.tenant_id}
                </div>
                <div className="h-meta capitalize">Role: {opt.role}</div>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="g-btn g-btn-ghost w-full mt-4"
            onClick={async () => { await signOutFully(); navigate("/auth", { replace: true }); }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="g-onboarding-root">
        <div className="glass g-onboarding-card text-center">
          <div className="orb g-onboarding-lock-orb mx-auto mb-4">
            <Lock size={26} />
          </div>
          <div className="h-label g-onboarding-denied-eyebrow mb-2">NO ACCESS</div>
          <div className="h-display g-auth-title mb-2">Account has no assigned role</div>
          <p className="h-meta mb-6">
            Your account exists but does not have a role yet. Ask the administrator
            for access from Settings → Users.
          </p>
          <button
            type="button"
            className="g-btn g-btn-ghost w-full"
            onClick={async () => { await signOutFully(); navigate("/auth", { replace: true }); }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (!needsBootstrap) return null;

  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 p-4 sm:p-8">
      <SetupWizard onCreateBusiness={createBusiness} />
    </div>
  );
}
