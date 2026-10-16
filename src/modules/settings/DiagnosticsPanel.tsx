import { useState } from "react";
import { FileDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { translate as tx, useLanguageStore } from "@/i18n";

/** Exports the local error log + system info to a file the owner can send to support. */
export function DiagnosticsPanel() {
  useLanguageStore((state) => state.language);
  const [busy, setBusy] = useState(false);
  const available = typeof window !== "undefined" && !!window.electron?.exportDiagnostics;
  const exportNow = async () => {
    if (!window.electron?.exportDiagnostics) return;
    setBusy(true);
    try {
      const result = await window.electron.exportDiagnostics();
      if (result.saved) toast.success(tx("Diagnostics saved. Attach the file to an email to ZAIPOS support."));
    } catch {
      toast.error(tx("Diagnostics could not be saved"));
    } finally { setBusy(false); }
  };
  return (
    <section className="glass rounded-2xl p-5 flex flex-col gap-3" data-testid="diagnostics-panel">
      <div>
        <h3 className="font-semibold">{tx("Diagnostics")}</h3>
        <p className="text-sm text-muted-foreground">{tx("Errors are recorded on this computer only (rotating log, passwords and tokens removed). Nothing is sent automatically.")}</p>
      </div>
      <Button onClick={exportNow} disabled={!available || busy} className="self-start" data-testid="send-diagnostics">
        <FileDown className="h-4 w-4 me-2" />{tx("Send diagnostics")}
      </Button>
      {!available && <p className="text-xs text-muted-foreground">{tx("Available in the ZAIPOS desktop app.")}</p>}
    </section>
  );
}
