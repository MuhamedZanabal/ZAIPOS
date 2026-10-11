import { useEffect } from "react";
import { toast } from "sonner";
import { replayOutbox, replayPendingCashMovements } from "@/lib/offlineOutbox";

/** Replays till operations saved while the server was unreachable: on start, when the network returns, and every minute. */
export function useOfflineReplay(): void {
  useEffect(() => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        const [outbox, cash] = await Promise.all([replayOutbox(), replayPendingCashMovements()]);
        const synced = outbox.synced + cash;
        if (synced > 0) toast.success(`${synced} offline operation${synced === 1 ? "" : "s"} synced to the server`);
        if (outbox.conflicts > 0) toast.error(`${outbox.conflicts} offline refund${outbox.conflicts === 1 ? "" : "s"} were rejected by the server and need manager review`);
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(run, 60_000);
    window.addEventListener("online", run);
    return () => { window.clearInterval(timer); window.removeEventListener("online", run); };
  }, []);
}
