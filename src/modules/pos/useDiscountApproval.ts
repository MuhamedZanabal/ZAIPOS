import { useState } from "react";
import { useTenantContext } from "@/hooks/useTenantContext";
import { needsManagerApproval } from "@/lib/discounts";
import { useCart } from "@/stores/cart";

/**
 * Cashiers may discount up to the tenant threshold (default 10%). Above it,
 * managers on the session pass through; everyone else needs a manager PIN,
 * whose verification id rides on the discounted lines for the server to check.
 */
export function useDiscountApproval() {
  const { tenantId, branchId, hasRole, discountThresholdPct } = useTenantContext();
  const approvalId = useCart((s) => s.discountApprovalId);
  const setApproval = useCart((s) => s.setDiscountApproval);
  const [pending, setPending] = useState<null | (() => void)>(null);
  const isManager = hasRole("owner", "admin", "manager");

  /** Runs `apply` now, or after manager approval when the discount is over the limit. */
  const guard = (discountFils: number, baseFils: number, apply: () => void) => {
    if (isManager || approvalId || !needsManagerApproval(discountFils, baseFils, discountThresholdPct)) {
      apply();
      return;
    }
    setPending(() => apply);
  };

  return {
    tenantId,
    branchId,
    thresholdPct: discountThresholdPct,
    guard,
    dialogOpen: pending !== null,
    closeDialog: () => setPending(null),
    approve: (verificationId: string) => {
      setApproval(verificationId);
      pending?.();
      setPending(null);
    },
  };
}
