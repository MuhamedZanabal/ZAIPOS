import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KeyRound, Plus, Users } from "lucide-react";
import { toast } from "sonner";

const ROLES = ["owner", "admin", "manager", "cashier", "waiter", "courier", "kitchen", "inventory", "staff"] as const;

export default function Employees() {
  const { tenantId, branchId } = useTenantContext();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pinEmployee, setPinEmployee] = useState<{ id: string; full_name: string } | null>(null);

  const { data: employees } = useQuery({
    queryKey: ["employees", tenantId],
    enabled: !!tenantId,
    queryFn: async () => (await supabase.from("employees").select("*")
      .eq("tenant_id", tenantId!).order("full_name")).data ?? [],
  });

  const list = employees ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="orb">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <div className="h-meta g-page-subtitle text-ink-400">BUSINESS · STAFF</div>
            <h1 className="h-display g-page-title">Employees</h1>
            <div className="h-meta g-page-subtitle text-ink-500">
              {list.length} team member{list.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <button type="button" className="g-btn g-btn-primary">
              <Plus className="h-4 w-4" />
              New employee
            </button>
          </DialogTrigger>
          <EmployeeForm
            tenantId={tenantId!}
            branchId={branchId!}
            onClose={() => { setOpen(false); qc.invalidateQueries({ queryKey: ["employees"] }); }}
          />
        </Dialog>
      </div>

      {/* Table */}
      {list.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center">
          <div className="orb mx-auto mb-4">
            <Users className="h-7 w-7" />
          </div>
          <h2 className="h-display font-semibold text-lg">No employees</h2>
          <p className="h-meta g-page-subtitle text-ink-500 mt-1">
            Add your team members to manage shifts and access.
          </p>
        </div>
      ) : (
        <div className="glass rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[2fr_2fr_1fr_120px_90px_110px] gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-400 border-b border-white/10">
            <span>Name</span>
            <span>Email</span>
            <span>Phone</span>
            <span>Role</span>
            <span>Status</span>
            <span>POS PIN</span>
          </div>
          {list.map((e: any, idx: number) => (
            <div
              key={e.id}
              className={`grid grid-cols-[2fr_2fr_1fr_120px_90px_110px] gap-3 px-4 py-3 items-center hover:bg-white/5 transition-colors${idx < list.length - 1 ? " border-b border-white/10" : ""}`}
            >
              <span className="font-medium text-sm text-ink-900">{e.full_name}</span>
              <span className="text-sm text-ink-700">{e.email ?? "—"}</span>
              <span className="text-sm text-ink-700">{e.phone ?? "—"}</span>
              <span className="g-pill g-pill-ghost capitalize">{e.role}</span>
              <span>
                {e.status === "active"
                  ? <span className="g-pill g-pill-ok">Active</span>
                  : <span className="g-pill g-pill-ghost">{e.status}</span>
                }
              </span>
              <button
                type="button"
                className="g-btn g-btn-ghost text-xs"
                onClick={() => setPinEmployee({ id: e.id, full_name: e.full_name })}
              >
                <KeyRound className="h-3.5 w-3.5" />
                Set PIN
              </button>
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!pinEmployee} onOpenChange={(value) => !value && setPinEmployee(null)}>
        {pinEmployee && (
          <SetPinDialog
            tenantId={tenantId!}
            branchId={branchId!}
            employee={pinEmployee}
            onClose={() => setPinEmployee(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

export function EmployeeForm({ tenantId, branchId, onClose }: { tenantId: string; branchId: string; onClose: () => void }) {
  const [form, setForm] = useState<any>({ full_name: "", email: "", phone: "", role: "cashier", pin: "", status: "active" });
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,8}$/u.test(form.pin)) return toast.error("PIN must contain 4 to 8 digits");
    setSaving(true);
    const { pin, ...employee } = form;
    const { data, error } = await supabase.from("employees")
      .insert({ ...employee, tenant_id: tenantId, branch_id: branchId })
      .select("id")
      .single();
    if (error || !data) {
      setSaving(false);
      return toast.error(error?.message ?? "Employee could not be created");
    }
    const { error: pinError } = await supabase.functions.invoke("pos-pin", {
      body: {
        action: "set",
        tenant_id: tenantId,
        branch_id: branchId,
        employee_id: data.id,
        pin,
      },
    });
    setSaving(false);
    if (pinError) {
      toast.error("Employee created, but POS PIN setup failed. Use Set PIN to retry.");
      onClose();
      return;
    }
    toast.success("Employee created");
    onClose();
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>New employee</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label>Full name</Label>
          <Input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>PIN (4-6 digits)</Label>
            <Input
              required
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,8}"
              maxLength={8}
              value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/gu, "") })}
            />
          </div>
        </div>
        <button type="submit" disabled={saving} className="g-btn g-btn-primary w-full g-btn-touch">
          {saving ? "Creating…" : "Create employee"}
        </button>
      </form>
    </DialogContent>
  );
}

function SetPinDialog({
  tenantId,
  branchId,
  employee,
  onClose,
}: {
  tenantId: string;
  branchId: string;
  employee: { id: string; full_name: string };
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{4,8}$/u.test(pin)) return toast.error("PIN must contain 4 to 8 digits");
    if (pin !== confirmation) return toast.error("PIN confirmation does not match");
    setSaving(true);
    const { error } = await supabase.functions.invoke("pos-pin", {
      body: {
        action: "set",
        tenant_id: tenantId,
        branch_id: branchId,
        employee_id: employee.id,
        pin,
      },
    });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(`POS PIN updated for ${employee.full_name}`);
    onClose();
  };

  return (
    <DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>Set POS PIN · {employee.full_name}</DialogTitle></DialogHeader>
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="employee-pos-pin">New PIN</Label>
          <Input
            id="employee-pos-pin"
            required
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]{4,8}"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/gu, ""))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="employee-pos-pin-confirmation">Confirm PIN</Label>
          <Input
            id="employee-pos-pin-confirmation"
            required
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]{4,8}"
            maxLength={8}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value.replace(/\D/gu, ""))}
          />
        </div>
        <button type="submit" disabled={saving} className="g-btn g-btn-primary w-full g-btn-touch">
          {saving ? "Saving…" : "Save PIN"}
        </button>
      </form>
    </DialogContent>
  );
}
