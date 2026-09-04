import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantContext } from "@/hooks/useTenantContext";
import { Switch } from "@/components/ui/switch";
import { Store, UtensilsCrossed, Bike, MessageCircle, Truck } from "lucide-react";
import { toast } from "sonner";
import {
  CHANNELS,
  normalizeBahrainChannels,
  type SalesChannel,
} from "@/lib/channels";

const ICONS: Record<SalesChannel, React.ReactNode> = {
  pos: <Store className="h-4 w-4" />,
  tables: <UtensilsCrossed className="h-4 w-4" />,
  talabat: <Bike className="h-4 w-4" />,
  whatsapp: <MessageCircle className="h-4 w-4" />,
  delivery: <Truck className="h-4 w-4" />,
};

const DESCRIPTIONS: Record<SalesChannel, string> = {
  pos: "Physical in-store point of sale.",
  tables: "On-site tables, waiter orders, and restaurant service.",
  talabat: "Bahrain delivery marketplace channel. API connectivity requires valid Talabat partner credentials and documented access.",
  whatsapp: "Orders and customer conversations handled through WhatsApp.",
  delivery: "Orders delivered by your own drivers or couriers.",
};

export default function SalesChannelsSettings() {
  const { tenantId, hasRole } = useTenantContext();
  const qc = useQueryClient();
  const isSuperAdmin = hasRole("super_admin");
  const [activeChannels, setActiveChannels] = useState<SalesChannel[]>([]);

  const { data: tenant, isLoading } = useQuery({
    queryKey: ["tenant-channels", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("active_channels")
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    setActiveChannels(normalizeBahrainChannels(tenant?.active_channels as string[] | null | undefined));
  }, [tenant]);

  const updateChannels = useMutation({
    mutationFn: async (channels: SalesChannel[]) => {
      const { error } = await supabase
        .from("tenants")
        .update({ active_channels: channels } as any)
        .eq("id", tenantId!);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Bahrain sales channels updated");
      qc.invalidateQueries({ queryKey: ["tenant-channels"] });
      qc.invalidateQueries({ queryKey: ["my-roles"] });
    },
    onError: (error: any) => toast.error(error.message),
  });

  const toggleChannel = (channel: SalesChannel, enabled: boolean) => {
    if (!isSuperAdmin) {
      toast.error("Only a super administrator can change sales channels.");
      return;
    }

    if (channel === "pos") return;

    const next = enabled
      ? Array.from(new Set([...activeChannels, channel]))
      : activeChannels.filter((value) => value !== channel);

    const normalized = normalizeBahrainChannels(next);
    setActiveChannels(normalized);
    updateChannels.mutate(normalized);
  };

  if (isLoading) return <div className="h-meta">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="glass p-6 rounded-2xl space-y-6">
        <div>
          <h2 className="font-bold flex items-center gap-2 text-ink-900">
            <Store className="h-5 w-5 text-brand-600" />
            Bahrain Sales Channels
          </h2>
          <p className="h-meta mt-1 max-w-3xl">
            ZAIPOS exposes only Bahrain-relevant active channels in the Bahrain-native interface.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {CHANNELS.map((channel) => {
            const active = channel.id === "pos" || activeChannels.includes(channel.id);
            const locked = channel.id === "pos";

            return (
              <div
                key={channel.id}
                className={`glass-thin rounded-xl p-4 flex flex-col gap-3 transition-opacity ${active ? "" : "opacity-60"}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold flex items-center gap-2 text-ink-900">
                    {ICONS[channel.id]}
                    {channel.label}
                  </div>
                  <Switch
                    checked={active}
                    disabled={locked || !isSuperAdmin || updateChannels.isPending}
                    onCheckedChange={(checked) => toggleChannel(channel.id, checked)}
                  />
                </div>
                <p className="h-meta">{DESCRIPTIONS[channel.id]}</p>
                {channel.id === "talabat" && (
                  <p className="text-xs text-muted-foreground">
                    ZAIPOS does not fabricate marketplace API access. Configure external connectivity only after Talabat provides the required partner contract and credentials.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
