import { supabase } from "@/integrations/supabase/client";
import { hardware, isElectron } from "@/lib/hardware";
import { desktopAuthorization } from "@/lib/desktopAuthorization";

/**
 * Enrols this desktop terminal for sales, cash and stock (same flow as
 * Settings → Devices → "Activate this terminal"). The owner running setup on
 * the shop computer approves it; no-op on the web or when already active.
 */
export async function ensureTerminalActivated(): Promise<"activated" | "already" | "not_desktop"> {
  if (!isElectron() || !hardware) return "not_desktop";
  const identity = await hardware.getDeviceIdentity();
  if (identity.provisioned) return "already";
  const authorization = await desktopAuthorization();
  const { data: created, error } = await (supabase as any).rpc("approve_device_enrollment", {
    _tenant_id: authorization.tenantId,
    _branch_id: authorization.branchId,
    _device_uid: identity.deviceUid,
  });
  let approvalId: unknown = created;
  if (error) {
    const { data: pending } = await (supabase as any)
      .from("device_enrollment_approvals")
      .select("id")
      .eq("device_uid", identity.deviceUid)
      .is("consumed_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    approvalId = pending?.id;
  }
  if (typeof approvalId !== "string") throw new Error(error?.message ?? "Could not activate this terminal for sales.");
  await hardware.activateDevice(approvalId, authorization);
  return "activated";
}
