import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { usePosEmployees, type Employee } from "./CashierSwitch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translate as tx } from "@/i18n";
import { englishServerMessage } from "@/lib/serverMessages";

const MANAGER_ROLES = ["owner", "admin", "manager"];

/**
 * Asks a manager to enter their POS PIN. On success returns the server's
 * verification id, which checkout cites as approval for a discount above the
 * tenant threshold (the server re-checks role, branch, actor and freshness).
 */
export function ManagerPinDialog({ open, onOpenChange, tenantId, branchId, cashSessionId, onApproved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string | null;
  branchId: string | null;
  cashSessionId?: string | null;
  onApproved: (verificationId: string, managerName: string) => void;
}) {
  const [selected, setSelected] = useState<Employee | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: employees = [] } = usePosEmployees(tenantId, branchId, open);
  const managers = employees.filter((e) => MANAGER_ROLES.includes(String(e.role)));

  const verify = async () => {
    if (!selected || !tenantId || !branchId || !/^\d{4,8}$/.test(pin)) return;
    setBusy(true);
    try {
      const identity = await window.electron?.getDeviceIdentity?.();
      if (!identity?.deviceUid) throw new Error(tx("PIN switching needs a registered desktop terminal"));
      const { data, error } = await supabase.functions.invoke("pos-pin", {
        body: { action: "verify", tenant_id: tenantId, branch_id: branchId, employee_id: selected.id, pin, device_uid: identity.deviceUid, cash_session_id: cashSessionId ?? null },
      });
      if (error) throw error;
      const id = (data as { verification_id?: string } | null)?.verification_id;
      if (!id) throw new Error(tx("Manager approval failed"));
      onApproved(id, selected.full_name);
      toast.success(`${tx("Approved by")} ${selected.full_name}`);
      onOpenChange(false); setSelected(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
      toast.error(/locked/i.test(message) ? tx("Too many wrong PINs. This cashier is locked for a few minutes.") : /incorrect|401/i.test(message) ? tx("Wrong PIN") : englishServerMessage(message));
    } finally { setPin(""); setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setSelected(null); setPin(""); } }}>
      <DialogContent className="max-w-sm" data-testid="manager-pin-dialog">
        <DialogHeader><DialogTitle>{tx("Manager approval")}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{tx("This discount is above the approval limit. A manager must enter their PIN.")}</p>
        {!selected ? (
          <div className="flex flex-col gap-2">
            {managers.length === 0 && <p className="text-sm">{tx("No manager with a POS PIN on this branch")}</p>}
            {managers.map((m) => (
              <Button key={m.id} variant="outline" onClick={() => setSelected(m)}>{m.full_name}</Button>
            ))}
          </div>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <p className="text-sm font-medium">{selected.full_name}</p>
            <Input type="password" inputMode="numeric" autoFocus value={pin} maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} placeholder="PIN" data-testid="manager-pin-input" />
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setSelected(null)}>{tx("Back")}</Button>
              <Button type="submit" className="flex-1" disabled={busy || pin.length < 4}>{tx("Approve")}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
