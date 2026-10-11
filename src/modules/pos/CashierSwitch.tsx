import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { translate as tx } from "@/i18n";
import { useActiveCashier } from "@/stores/activeCashier";
import { englishServerMessage } from "@/lib/serverMessages";

interface Employee { id: string; full_name: string; role: string | null }

/** Header control on the register: shows the cashier at the till and switches by PIN. */
export function CashierSwitch({ tenantId, branchId, cashSessionId }: { tenantId: string | null; branchId: string | null; cashSessionId?: string | null }) {
  const { cashier, setCashier } = useActiveCashier();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Employee | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: employees = [] } = useQuery({
    queryKey: ["pos-cashiers", tenantId, branchId],
    enabled: open && !!tenantId && !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.from("employees").select("id, full_name, role").eq("tenant_id", tenantId!).eq("branch_id", branchId!).eq("status", "active").order("full_name");
      if (error) throw error;
      return (data ?? []) as Employee[];
    },
  });
  const current = cashier && cashier.branchId === branchId ? cashier : null;

  const verify = async () => {
    if (!selected || !tenantId || !branchId || !/^\d{4,8}$/.test(pin)) return;
    setBusy(true);
    try {
      const identity = await window.electron?.getDeviceIdentity?.();
      if (!identity?.deviceUid) throw new Error(tx("PIN switching needs a registered desktop terminal"));
      const { error } = await supabase.functions.invoke("pos-pin", {
        body: { action: "verify", tenant_id: tenantId, branch_id: branchId, employee_id: selected.id, pin, device_uid: identity.deviceUid, cash_session_id: cashSessionId ?? null },
      });
      if (error) throw error;
      setCashier({ employeeId: selected.id, name: selected.full_name, role: selected.role, branchId, verifiedAt: new Date().toISOString() });
      toast.success(`${tx("Cashier switched to")} ${selected.full_name}`);
      setOpen(false); setSelected(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
      toast.error(/locked/i.test(message) ? tx("Too many wrong PINs. This cashier is locked for a few minutes.") : /incorrect|401/i.test(message) ? tx("Wrong PIN") : englishServerMessage(message));
    } finally { setPin(""); setBusy(false); }
  };

  return (
    <>
      <button type="button" data-testid="cashier-switch" onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 shrink-0 px-3 border-l self-stretch text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60">
        <UserRound className="h-4 w-4" aria-hidden="true" />
        <span className="hidden md:inline">{current ? current.name : tx("Switch cashier")}</span>
      </button>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSelected(null); setPin(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{selected ? `${tx("Enter PIN for")} ${selected.full_name}` : tx("Who is at the till?")}</DialogTitle></DialogHeader>
          {!selected ? (
            <div className="grid grid-cols-2 gap-2 max-h-80 overflow-auto">
              {employees.length === 0 && <p className="col-span-2 text-sm text-muted-foreground">{tx("No staff with a POS PIN yet. Set PINs in Employees.")}</p>}
              {employees.map((e) => (
                <Button key={e.id} variant="outline" className="h-14 justify-start" onClick={() => setSelected(e)}>{e.full_name}</Button>
              ))}
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={(ev) => { ev.preventDefault(); void verify(); }}>
              <Input autoFocus inputMode="numeric" type="password" autoComplete="off" maxLength={8} value={pin}
                onChange={(ev) => setPin(ev.target.value.replace(/\D/g, ""))} aria-label={tx("PIN")} data-testid="cashier-pin" className="text-center text-2xl tracking-[0.5em]" />
              <div className="grid grid-cols-3 gap-2" dir="ltr">
                {["1","2","3","4","5","6","7","8","9","C","0","⌫"].map((k) => (
                  <Button key={k} type="button" variant="outline" className="h-12 text-lg"
                    onClick={() => setPin((p) => k === "C" ? "" : k === "⌫" ? p.slice(0, -1) : (p + k).slice(0, 8))}>{k}</Button>
                ))}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => { setSelected(null); setPin(""); }}>{tx("Back")}</Button>
                <Button type="submit" className="flex-1" disabled={busy || pin.length < 4}>{tx("Switch")}</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
