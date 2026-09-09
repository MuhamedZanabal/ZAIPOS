import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { PageHeader } from "@/components/shared/PageHeader";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { bhdToFils, filsToBhd, formatFils } from "@/lib/bahrain";
import { CHANNELS, type SalesChannel } from "@/lib/channels";
import { createProductFinancialOperationId, setProductSellingPrice } from "@/lib/productFinancialCommands";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/EmptyState";
import { Tags } from "lucide-react";
import "./channel-prices.css";


export default function ChannelPrices() {
  const { tenantId, branches } = useTenantContext();
  const qc = useQueryClient();

  // branchId === "" means "Global (all branches)"
  const [branchScope, setBranchScope] = useState<string>("__global__");


  const { data: products } = useQuery({
    queryKey: ["chprice-products", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, price_fils, sku, product_type")
        .eq("tenant_id", tenantId!)
        .eq("status", "active")
        .neq("product_type", "ingredient")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: prices } = useQuery({
    queryKey: ["chprice-rows", tenantId, branchScope],
    enabled: !!tenantId,
    queryFn: async () => {
      let q = supabase
        .from("product_channel_prices")
        .select("product_id, branch_id, channel, price_fils")
        .eq("tenant_id", tenantId!);
      if (branchScope === "__global__") q = q.is("branch_id", null);
      else q = q.eq("branch_id", branchScope);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });

  const priceMap = useMemo(() => {
    const m: Record<string, Record<SalesChannel, number>> = {};
    (prices ?? []).forEach((p) => {
      if (!m[p.product_id]) m[p.product_id] = {} as any;
      m[p.product_id][p.channel as SalesChannel] = Number(p.price_fils);
    });
    return m;
  }, [prices]);

  const updatePrice = async (productId: string, channel: SalesChannel, value: string | null) => {
    if (!tenantId) return;
    try {
      await setProductSellingPrice({
        tenantId,
        productId,
        branchId: branchScope === "__global__" ? null : branchScope,
        channel,
        amountBhd: value,
        reason: "Channel price management",
        operationId: createProductFinancialOperationId("channel-price"),
      });
      qc.invalidateQueries({ queryKey: ["chprice-rows"] });
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const commitPriceInput = (productId: string, channel: SalesChannel, value: string, currentFils?: number) => {
    try {
      const nextValue = value.trim() === "" ? null : value.trim();
      const changed = nextValue === null ? currentFils != null : bhdToFils(nextValue) !== currentFils;
      if (changed) void updatePrice(productId, channel, nextValue);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Enter a valid BHD amount");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="CATALOG · PRICES"
        title="Prices by channel"
        description="Set a different price for each sales channel. Leave blank to use the base price."
        actions={
          <Select value={branchScope} onValueChange={setBranchScope}>
            <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__global__">Global (all branches)</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>Only: {b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {!products || products.length === 0 ? (
        <EmptyState icon={Tags} title="No products" description="Create products first in the Products module" />
      ) : (
        <div className="glass rounded-2xl overflow-hidden">
          <div className="grid px-5 py-3 text-xs font-semibold text-ink-400 uppercase tracking-wider border-b border-[var(--g-hairline)] g-channel-grid">
            <div>Product</div>
            <div className="text-right">Base price</div>
            {CHANNELS.map((c) => (
              <div key={c.id} className="text-right">{c.label}</div>
            ))}
          </div>
          <div className="divide-y divide-[var(--g-hairline)]">
            {products.map((p) => (
              <div key={p.id} className="grid items-center px-5 py-2.5 hover:bg-white/10 transition-colors g-channel-grid">
                <div>
                  <div className="font-medium text-ink-900">{p.name}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {p.sku && <span className="h-meta text-xs">SKU {p.sku}</span>}
                    <span className="g-pill g-pill-ghost g-pill-h22">{p.product_type}</span>
                  </div>
                </div>
                <div className="text-right tabular-nums h-meta">
                  {formatFils(Number(p.price_fils))}
                </div>
                {CHANNELS.map((c) => {
                  const v = priceMap[p.id]?.[c.id];
                  return (
                    <div key={c.id} className="flex justify-end">
                      <Input
                        key={`${p.id}-${c.id}-${branchScope}-${v ?? "empty"}`}
                        type="number"
                        min="0"
                        step="0.001"
                        placeholder="—"
                        defaultValue={v == null ? "" : filsToBhd(v)}
                        onBlur={(event) => commitPriceInput(p.id, c.id, event.target.value, v)}
                        className="w-[130px] text-right tabular-nums h-9"
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
