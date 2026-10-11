import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { useDevMode } from "@/hooks/useDevMode";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { BusinessTypeSettings } from "./BusinessTypeSettings";
import { Save, FlaskConical } from "lucide-react";
import {
  BAHRAIN_CURRENCY,
  BAHRAIN_STANDARD_VAT,
} from "@/lib/bahrain";
import { translate as tx, useLanguageStore } from "@/i18n";

const CURRENCIES = [BAHRAIN_CURRENCY] as const;

export default function BusinessSettings() {
  useLanguageStore((state) => state.language); // re-render on language change
  const { tenantId, hasRole } = useTenantContext();
  const qc = useQueryClient();
  const canEdit = hasRole("owner", "admin");
  const { devMode, canToggle, setDevMode, isPending: devModePending } = useDevMode();

  const { data: tenant, isLoading } = useQuery({
    queryKey: ["tenant", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("id, name, currency, tax_rate, discount_approval_threshold_pct")
        .eq("id", tenantId!)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const [form, setForm] = useState({
    name: "",
    currency: BAHRAIN_CURRENCY as string,
    tax_rate: BAHRAIN_STANDARD_VAT as number,
    discount_threshold: 10,
  });

  useEffect(() => {
    if (tenant) {
      setForm({
        name: tenant.name ?? "",
        currency: tenant.currency || BAHRAIN_CURRENCY,
        tax_rate: Number(tenant.tax_rate ?? BAHRAIN_STANDARD_VAT),
        discount_threshold: Number((tenant as { discount_approval_threshold_pct?: number | null }).discount_approval_threshold_pct ?? 10),
      });
    }
  }, [tenant]);

  const save = async () => {
    if (!tenantId) return;
    if (!form.name.trim()) return toast.error(tx("Business name is required"));
    if (!(form.discount_threshold >= 0 && form.discount_threshold <= 100)) return toast.error(tx("Discount approval limit must be between 0 and 100%"));

    const { error } = await supabase
      .from("tenants")
      .update({
        name: form.name.trim(),
        currency: BAHRAIN_CURRENCY,
        tax_rate: form.tax_rate,
        discount_approval_threshold_pct: form.discount_threshold,
      } as never)
      .eq("id", tenantId);

    if (error) return toast.error(error.message);

    toast.success(tx("Business information updated"));
    qc.invalidateQueries({ queryKey: ["tenant"] });
    qc.invalidateQueries({ queryKey: ["my-roles"] });
  };

  if (isLoading) return <div className="h-meta">{tx("Loading…")}</div>;

  return (
    <div className="space-y-6">
      <BusinessTypeSettings />
      <div className="glass p-6 rounded-2xl max-w-2xl space-y-5">
        <div className="space-y-1.5">
          <Label>{tx("Business name")}</Label>
          <Input
            placeholder={tx("Amwaj Market")}
            value={form.name}
            disabled={!canEdit}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{tx("Currency")}</Label>
            <Select
              value={BAHRAIN_CURRENCY}
              disabled
              onValueChange={(v) => setForm({ ...form, currency: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((currency) => (
                  <SelectItem key={currency} value={currency}>
                    {currency} — Bahraini Dinar
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {tx("ZAIPOS is configured for Bahrain and uses BHD with three-decimal precision.")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{tx("Default VAT (%)")}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="0.01"
              disabled={!canEdit}
              value={form.tax_rate}
              onChange={(e) => setForm({ ...form, tax_rate: Number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">
              {tx("Bahrain standard VAT is 10%. Use product-level tax treatment for zero-rated or exempt supplies.")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{tx("Cashier discount limit (%)")}</Label>
            <Input
              type="number"
              min={0}
              max={100}
              step="0.5"
              disabled={!canEdit}
              value={form.discount_threshold}
              data-testid="discount-threshold"
              onChange={(e) => setForm({ ...form, discount_threshold: Number(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">
              {tx("Cashiers can discount up to this percentage. Larger discounts need a manager PIN.")}
            </p>
          </div>
        </div>

        {canEdit ? (
          <div className="pt-2">
            <button type="button" className="g-btn g-btn-primary" onClick={save}>
              <Save className="h-4 w-4" /> {tx("Save changes")}
            </button>
          </div>
        ) : (
          <p className="h-meta">
            {tx("Only the owner or administrators can edit this information.")}
          </p>
        )}
      </div>

      {canToggle && (
        <div className="glass p-6 rounded-2xl max-w-2xl border border-orange-200/60">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="orb orb-sq w-9 h-9">
                <FlaskConical className="h-4 w-4 text-orange-500" />
              </span>
              <div className="space-y-1">
                <p className="font-semibold text-sm text-ink-900">{tx("Development mode")}</p>
                <p className="h-meta max-w-sm">
                  {tx("Allows sales and orders to be recorded regardless of available stock. Use this only for testing and demonstrations.")}
                </p>
              </div>
            </div>
            <Switch
              checked={devMode}
              disabled={devModePending}
              onCheckedChange={(checked) => {
                setDevMode(checked);
                toast[checked ? "warning" : "success"](
                  checked ? "Development mode enabled" : "Development mode disabled"
                );
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
