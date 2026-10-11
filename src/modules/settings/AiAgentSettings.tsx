import { Bot, Database, LockKeyhole, ShieldCheck } from 'lucide-react';
import { translate as tx, useLanguageStore } from "@/i18n";

export default function AiAgentSettings() {
  useLanguageStore((state) => state.language); // re-render on language change
  return (
    <div className="space-y-5">
      <div className="glass space-y-4 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4 text-primary" /> ZAIPOS AI
          <span className="pill pill-ok ml-auto">{tx("Source-backed read only")}</span>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          ZAIPOS AI can read the authorized branch reporting snapshot through a server-controlled evidence boundary.
          Autonomous ordering and operational mutation tools remain disabled.
        </p>
      </div>

      <div className="glass grid gap-4 p-5 md:grid-cols-3">
        <div className="flex gap-3">
          <Database className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-medium">{tx("Authoritative evidence")}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {tx("Live facts come from tenant/branch-scoped reporting data with exact integer fils and source metadata.")}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-medium">Server authorization</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Branch access is validated by the server-side controller before operational facts are returned.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-medium">{tx("Writes blocked")}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {tx("Legacy AI order, quote and handoff RPCs remain revoked. Business-state mutations require normal ZAIPOS commands.")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
