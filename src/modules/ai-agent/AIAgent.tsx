import { Database, Lightbulb, SearchCheck, ShieldCheck } from 'lucide-react';

const DISCLOSURES = [
  {
    icon: SearchCheck,
    title: 'Fact',
    text: 'No source query was executed. ZAIPOS is not displaying live operational metrics on this screen.',
  },
  {
    icon: Database,
    title: 'Inference',
    text: 'Unavailable. An inference requires cited, tenant-scoped tool evidence and a clearly identified calculation.',
  },
  {
    icon: Lightbulb,
    title: 'Recommendation',
    text: 'Unavailable. Recommendations will be enabled only after the underlying read tools and evidence model pass authorization tests.',
  },
];

export default function AIAgent() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="glass space-y-4 p-6">
        <div className="flex items-center gap-3">
          <div className="orb grid h-11 w-11 place-items-center">
            <ShieldCheck className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="h-display text-xl">ZAIPOS AI</h1>
            <p className="h-meta">Read-only safety mode</p>
          </div>
          <span className="pill pill-warn ml-auto">P0 LOCKED</span>
        </div>

        <p className="text-sm leading-6 text-muted-foreground">
          Live operational analysis is unavailable until source-backed, server-authorized read tools are enabled.
          The former demonstration metrics and simulated data retrieval have been removed.
        </p>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          No AI mutation tools are active. AI cannot create or alter sales, payments, inventory, supplier balances,
          cash sessions, prices, refunds, orders, or other business state.
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {DISCLOSURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="glass space-y-3 p-5">
            <Icon className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">{title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>

      <div className="glass-thin p-4 text-xs leading-5 text-muted-foreground">
        Future answers must carry evidence metadata including tool name, tenant and branch scope, time range,
        source dataset, entity references, and generation time. Authorization will be enforced on the server,
        not inferred from whether a frontend control is visible.
      </div>
    </div>
  );
}
