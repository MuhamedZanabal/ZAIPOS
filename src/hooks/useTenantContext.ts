import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantStore } from "@/stores/tenant";
import { useAuth } from "./useAuth";
import { Branch } from "@/types/branch";
import { useEffect, useMemo } from "react";
import { normalizeBahrainChannels } from "@/lib/channels";

type TenantSummary = {
  id: string;
  name: string;
  currency: string | null;
  tax_rate: number | null;
  active_channels: string[] | null;
};

function isTenantSummary(value: unknown): value is TenantSummary {
  return !!value && typeof value === "object" && "id" in value;
}

export function useTenantContext() {
  const { user } = useAuth();
  const { tenantId, branchId, setTenant, setBranch } = useTenantStore();

  const { data: memberships, isLoading: loadingRoles } = useQuery({
    queryKey: ["my-roles", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("tenant_id, role, branch_id, tenants(id, name, currency, tax_rate, active_channels)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: branches } = useQuery({
    queryKey: ["branches", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("*")
        .eq("tenant_id", tenantId!)
        .eq("status", "active")
        .order("name");
      if (error) throw error;
      return (data ?? []) as Branch[];
    },
  });

  const tenantMemberships = useMemo(
    () => (memberships ?? []).filter((membership) => membership.tenant_id === tenantId),
    [memberships, tenantId],
  );

  const branchScopedIds = useMemo(
    () => tenantMemberships.map((membership) => membership.branch_id).filter(Boolean) as string[],
    [tenantMemberships],
  );

  useEffect(() => {
    if (!branchId && branches && branches.length > 0) {
      const scoped = branches.find((branch) => branchScopedIds.includes(branch.id));
      setBranch(scoped?.id ?? branches[0].id);
    }
  }, [branches, branchId, branchScopedIds, setBranch]);

  const roles = useMemo(
    () => tenantMemberships
      .filter((membership) => !membership.branch_id || !branchId || membership.branch_id === branchId)
      .map((membership) => membership.role),
    [branchId, tenantMemberships],
  );

  const hasRole = (...needed: string[]) =>
    roles.includes("super_admin") || roles.some((role) => needed.includes(role));

  const isAuthorizedForDomain = !loadingRoles && tenantMemberships.length > 0;

  const activeChannels = useMemo(() => {
    const tenantObj = memberships?.find((membership) => membership.tenant_id === tenantId)?.tenants;
    if (isTenantSummary(tenantObj) && Array.isArray(tenantObj.active_channels)) {
      return normalizeBahrainChannels(tenantObj.active_channels);
    }
    return normalizeBahrainChannels(null);
  }, [memberships, tenantId]);

  return {
    tenantId,
    branchId,
    setTenant,
    setBranch,
    memberships: memberships ?? [],
    branches: branches ?? [],
    roles,
    hasRole,
    isAuthorizedForDomain,
    isLoading: loadingRoles,
    needsOnboarding: !loadingRoles && (memberships?.length ?? 0) === 0,
    activeChannels,
  };
}
