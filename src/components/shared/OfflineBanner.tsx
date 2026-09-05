import { useEffect, useState } from "react";
import { useNetworkStore } from "@/stores/network";
import { SyncQueuePanel } from "./SyncQueuePanel";
import { WifiOff, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type BannerState = "hidden" | "offline" | "syncing" | "attention" | "done";

export function OfflineBanner() {
  const { isOnline, pendingSyncCount, syncAttentionCount } = useNetworkStore();
  const [bannerState, setBannerState] = useState<BannerState>("hidden");
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setBannerState("offline");
      return;
    }

    if (syncAttentionCount > 0) {
      setBannerState("attention");
      return;
    }

    if (pendingSyncCount > 0) {
      setBannerState("syncing");
      return;
    }

    // Was syncing and now count hit 0 → show "done" briefly
    if (bannerState === "syncing" || bannerState === "attention") {
      setBannerState("done");
      const t = setTimeout(() => setBannerState("hidden"), 3000);
      return () => clearTimeout(t);
    }

    setBannerState("hidden");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, pendingSyncCount, syncAttentionCount]);

  if (bannerState === "hidden") return null;

  const configs = {
    offline: {
      bg: "bg-destructive",
      text: "text-destructive-foreground",
      icon: <WifiOff className="h-4 w-4 shrink-0" />,
      message: pendingSyncCount > 0
        ? `Offline · ${pendingSyncCount} transaction${pendingSyncCount !== 1 ? "s" : ""} awaiting sync`
        : "Offline · Offline mode active",
    },
    syncing: {
      bg: "bg-amber-500",
      text: "text-white",
      icon: <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />,
      message: `Syncing ${pendingSyncCount} pending transaction${pendingSyncCount !== 1 ? "s" : ""}…`,
    },
    attention: {
      bg: "bg-orange-600",
      text: "text-white",
      icon: <AlertTriangle className="h-4 w-4 shrink-0" />,
      message: `${syncAttentionCount} transaction${syncAttentionCount !== 1 ? "s" : ""} need${syncAttentionCount === 1 ? "s" : ""} attention`,
    },
    done: {
      bg: "bg-green-600",
      text: "text-white",
      icon: <CheckCircle2 className="h-4 w-4 shrink-0" />,
      message: "Synchronization complete",
    },
  } as const;

  const cfg = configs[bannerState];

  return (
    <>
      <button
        type="button"
        aria-label="View sync queue"
        onClick={() => (bannerState !== "done" ? setPanelOpen(true) : undefined)}
        className={cn(
          "w-full flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-semibold",
          "transition-all duration-300 cursor-pointer select-none",
          cfg.bg,
          cfg.text,
          bannerState === "done" && "cursor-default",
        )}
      >
        {cfg.icon}
        <span>{cfg.message}</span>
        {bannerState !== "done" && (
          <span className="ml-1 underline underline-offset-2 text-xs font-normal opacity-80">
            View details
          </span>
        )}
      </button>

      <SyncQueuePanel open={panelOpen} onOpenChange={setPanelOpen} />
    </>
  );
}
