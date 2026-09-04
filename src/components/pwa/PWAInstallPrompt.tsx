import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Download, RefreshCw } from "lucide-react";
import { applyPWAUpdate } from "@/pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa-install-dismissed-at";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

function isElectron() {
  return typeof window !== "undefined" && Boolean(window.electron);
}

export function PWAInstallPrompt() {
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isElectron() || isStandalone()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;

      const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return;

      toast("Install ZAIPOS", {
        description:
          "Install ZAIPOS on this device to open it as an app and work offline.",
        duration: Infinity,
        icon: <Download className="h-4 w-4" />,
        action: {
          label: "Install",
          onClick: async () => {
            const promptEvent = deferredPromptRef.current;
            if (!promptEvent) return;
            await promptEvent.prompt();
            const choice = await promptEvent.userChoice;
            if (choice.outcome === "accepted") {
              toast.success("ZAIPOS installed!");
            }
            deferredPromptRef.current = null;
          },
        },
        cancel: {
          label: "Not now",
          onClick: () => {
            localStorage.setItem(DISMISS_KEY, String(Date.now()));
          },
        },
      });
    };

    const onInstalled = () => {
      deferredPromptRef.current = null;
      localStorage.removeItem(DISMISS_KEY);
      toast.success("ZAIPOS installed successfully");
    };

    const onUpdateAvailable = () => {
      toast("New ZAIPOS version available", {
        description: "Update to get the latest improvements.",
        duration: Infinity,
        icon: <RefreshCw className="h-4 w-4" />,
        action: {
          label: "Update",
          onClick: () => {
            void applyPWAUpdate();
          },
        },
      });
    };

    const onOfflineReady = () => {
      toast.success("ZAIPOS is ready to work offline");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("pwa:update-available", onUpdateAvailable);
    window.addEventListener("pwa:offline-ready", onOfflineReady);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("pwa:update-available", onUpdateAvailable);
      window.removeEventListener("pwa:offline-ready", onOfflineReady);
    };
  }, []);

  return null;
}
