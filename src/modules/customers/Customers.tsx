import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Users, Plus, Pencil, Trash2, Search, Phone, Mail, Heart } from "lucide-react";
import { toast } from "sonner";
import { normalizeBahrainPhone } from "@/lib/bahrain";

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  document_number: string | null;
  address?: string | null;
  loyalty_points?: number | null;
  created_at: string;
};

type FormData = {
  name: string;
  phone: string;
  email: string;
  document_number: string;
  address: string;
};

const empty: FormData = { name: "", phone: "", email: "", document_number: "", address: "" };

export default function Customers() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState<FormData>(empty);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("name");
      return (data ?? []) as Customer[];
    },
  });

  const save = useMutation({
    mutationFn: async (values: FormData) => {
      const rawPhone = values.phone.trim();
      const payload = {
        tenant_id: tenantId!,
        name: values.name.trim(),
        phone: rawPhone ? normalizeBahrainPhone(rawPhone) : null,
        email: values.email.trim() || null,
        document_number: values.document_number.trim() || null,
        address: values.address.trim() || null,
      };

      if (editing) {
        const { error } = await supabase.from("customers").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("customers").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(editing ? "Customer updated" : "Customer created");
      qc.invalidateQueries({ queryKey: ["customers"] });
      setOpen(false);
      setEditing(null);
      setForm(empty);
    },
    onError: (error: any) => toast.error(error.message ?? "Error saving customer"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("customers").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Customer deleted");
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (error: any) => toast.error(error.message ?? "Error deleting customer"),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(empty);
    setOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditing(customer);
    setForm({
      name: customer.name,
      phone: customer.phone ?? "",
      email: customer.email ?? "",
      document_number: customer.document_number ?? "",
      address: customer.address ?? "",
    });
    setOpen(true);
  };

  const normalizedSearch = search.toLowerCase();
  const filtered = customers.filter((customer) =>
    customer.name.toLowerCase().includes(normalizedSearch) ||
    (customer.phone ?? "").includes(search) ||
    (customer.email ?? "").toLowerCase().includes(normalizedSearch) ||
    (customer.document_number ?? "").includes(search)
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="orb"><Users className="h-5 w-5" /></div>
          <div>
            <div className="h-meta g-page-subtitle text-ink-400">OPERATIONS · CUSTOMERS</div>
            <h1 className="h-display g-page-title">Customers</h1>
            <div className="h-meta g-page-subtitle text-ink-500">
              {customers.length} registered customer{customers.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
        <button type="button" className="g-btn g-btn-primary" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New customer
        </button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-400" />
        <Input
          className="pl-9"
          placeholder="Search by name, +973 phone, CPR/CR..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center">
          <div className="orb mx-auto mb-4"><Users className="h-7 w-7" /></div>
          <h2 className="h-display font-semibold text-lg">No customers</h2>
          <p className="h-meta g-page-subtitle text-ink-500 mt-1">
            Register customers to link them to sales and view their history.
          </p>
        </div>
      ) : (
        <div className="glass rounded-2xl overflow-hidden">
          <div className="grid grid-cols-[2fr_1fr_2fr_2fr_100px_72px] gap-3 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-400 border-b border-white/10">
            <span>Name</span>
            <span>CPR / CR</span>
            <span>Contact</span>
            <span>Address</span>
            <span className="text-right">Points</span>
            <span />
          </div>

          {filtered.map((customer, index) => (
            <div
              key={customer.id}
              className={`grid grid-cols-[2fr_1fr_2fr_2fr_100px_72px] gap-3 px-4 py-3 items-center hover:bg-white/5 transition-colors${index < filtered.length - 1 ? " border-b border-white/10" : ""}`}
            >
              <span className="font-medium text-sm text-ink-900">{customer.name}</span>
              <span className="text-sm tabular-nums text-ink-500">{customer.document_number ?? "—"}</span>

              <div className="flex flex-col gap-0.5">
                {customer.phone && (
                  <span className="flex items-center gap-1 text-sm text-ink-700">
                    <Phone className="h-3 w-3 text-ink-400" /> {customer.phone}
                  </span>
                )}
                {customer.email && (
                  <span className="flex items-center gap-1 text-sm text-ink-500">
                    <Mail className="h-3 w-3 text-ink-400" /> {customer.email}
                  </span>
                )}
                {!customer.phone && !customer.email && <span className="text-sm text-ink-400">—</span>}
              </div>

              <span className="text-sm text-ink-500">{customer.address ?? "—"}</span>

              <div className="flex justify-end">
                <span className="g-pill g-pill-warn flex items-center gap-1">
                  <Heart className="h-3 w-3 fill-current" /> {customer.loyalty_points ?? 0}
                </span>
              </div>

              <div className="flex gap-1 justify-end">
                <button
                  type="button"
                  aria-label="Edit customer"
                  className="g-btn g-btn-ghost h-8 w-8 p-0 flex items-center justify-center"
                  onClick={() => openEdit(customer)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Delete customer"
                  className="g-btn g-btn-ghost h-8 w-8 p-0 flex items-center justify-center text-g-bad"
                  onClick={() => {
                    if (confirm("Delete customer?")) remove.mutate(customer.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setEditing(null);
            setForm(empty);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit customer" : "New customer"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Full name or legal name"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>CPR / CR</Label>
                <Input
                  value={form.document_number}
                  onChange={(event) => setForm((current) => ({ ...current, document_number: event.target.value }))}
                  placeholder="Bahrain identifier"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                  placeholder="+973 3600 1234"
                  inputMode="tel"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="customer@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Address</Label>
              <Input
                value={form.address}
                onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
                placeholder="Amwaj Islands, Muharraq, Bahrain"
              />
            </div>

            <button
              type="button"
              className="g-btn g-btn-primary w-full"
              disabled={!form.name.trim() || save.isPending}
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? "Saving..." : editing ? "Save changes" : "Create customer"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
