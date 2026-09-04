import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Image, Layout, Save, Eye } from "lucide-react";
import { formatCurrency } from "@/lib/format";

export default function ReceiptSettings() {
  const { tenantId } = useTenantContext();
  const qc = useQueryClient();
  const [config, setConfig] = useState({
    header_text: "",
    footer_text: "",
    show_logo: true,
    show_tax_details: true,
    show_customer_info: true,
    font_size: "small",
  });

  const { data: tenant } = useQuery({
    queryKey: ["tenant-receipt-config", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase.from("tenants").select("*").eq("id", tenantId!).single();
      return data;
    },
  });

  useEffect(() => {
    if (tenant?.receipt_config) setConfig(tenant.receipt_config as any);
  }, [tenant]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("tenants")
        .update({ receipt_config: config })
        .eq("id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Receipt settings saved");
      qc.invalidateQueries({ queryKey: ["tenant-receipt-config"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const sampleSubtotal = 9.091;
  const sampleVat = 0.909;
  const sampleTotal = 10.0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-6">
      <div className="space-y-6">
        <div className="glass p-6 rounded-2xl space-y-6">
          <div className="flex items-center gap-2 font-bold text-ink-900">
            <Layout className="h-5 w-5 text-brand-600" /> Receipt Layout
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label>Header text</Label>
              <Input
                placeholder="CR: 123456-1 | Manama, Kingdom of Bahrain | +973 1700 0000"
                value={config.header_text}
                onChange={(e) => setConfig({ ...config, header_text: e.target.value })}
              />
              <p className="h-meta">
                Use this for the commercial registration number, Bahrain address, VAT account number when applicable, and contact details.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Footer text</Label>
              <Textarea
                placeholder="Thank you for shopping with us."
                value={config.footer_text}
                onChange={(e) => setConfig({ ...config, footer_text: e.target.value })}
                className="min-h-[100px]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label>Show logo</Label>
                  <p className="h-meta">Include the business logo on the receipt.</p>
                </div>
                <Switch
                  checked={config.show_logo}
                  onCheckedChange={(v) => setConfig({ ...config, show_logo: v })}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label>VAT details</Label>
                  <p className="h-meta">Show taxable amount and Bahrain VAT breakdown.</p>
                </div>
                <Switch
                  checked={config.show_tax_details}
                  onCheckedChange={(v) => setConfig({ ...config, show_tax_details: v })}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <div>
                  <Label>Customer details</Label>
                  <p className="h-meta">Show customer name and identifier when linked to the sale.</p>
                </div>
                <Switch
                  checked={config.show_customer_info}
                  onCheckedChange={(v) => setConfig({ ...config, show_customer_info: v })}
                />
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-black/5 flex justify-end">
            <button type="button" className="g-btn g-btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
              <Save className="h-4 w-4" /> Save changes
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="h-label uppercase tracking-widest flex items-center gap-2">
          <Eye className="h-3 w-3" /> Receipt preview (80 mm)
        </div>
        <div className="bg-white text-black p-6 font-mono text-[10px] shadow-lg border-2 border-dashed rounded-xl">
          <div className="text-center space-y-1 mb-4">
            {config.show_logo && (
              <div className="h-12 w-12 bg-gray-100 rounded-full mx-auto mb-2 grid place-items-center">
                <Image className="h-6 w-6 text-gray-300" />
              </div>
            )}
            <div className="font-bold text-sm uppercase">{tenant?.name || "ZAIPOS BAHRAIN STORE"}</div>
            <div className="whitespace-pre-line text-slate-600">
              {config.header_text || "CR: 123456-1\nManama, Kingdom of Bahrain\nTel: +973 1700 0000"}
            </div>
          </div>

          <div className="border-t border-b border-dashed py-2 mb-2 space-y-1">
            <div className="flex justify-between">
              <span>RECEIPT #1234</span>
              <span>04/09/2026 13:00</span>
            </div>
            {config.show_customer_info && <div className="text-[9px]">CUSTOMER: WALK-IN CUSTOMER</div>}
          </div>

          <div className="space-y-1 mb-4">
            <div className="flex justify-between"><span>2 × PRODUCT A</span><span>{formatCurrency(6)}</span></div>
            <div className="flex justify-between"><span>1 × PRODUCT B</span><span>{formatCurrency(4)}</span></div>
          </div>

          <div className="border-t border-dashed pt-2 space-y-1">
            <div className="flex justify-between font-bold text-xs">
              <span>TOTAL</span><span>{formatCurrency(sampleTotal)}</span>
            </div>
            {config.show_tax_details && (
              <div className="text-[8px] opacity-60">
                <div className="flex justify-between"><span>Taxable amount:</span><span>{formatCurrency(sampleSubtotal)}</span></div>
                <div className="flex justify-between"><span>VAT (10%):</span><span>{formatCurrency(sampleVat)}</span></div>
              </div>
            )}
          </div>

          <div className="mt-6 text-center whitespace-pre-line italic opacity-70">
            {config.footer_text || "Thank you for your purchase!\nPowered by ZAIPOS"}
          </div>
        </div>
      </div>
    </div>
  );
}
