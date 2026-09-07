import { Bot, LockKeyhole, ShieldCheck } from 'lucide-react';

export default function AiAgentSettings() {
  return (
    <div className="space-y-5">
      <div className="glass space-y-4 p-5">
        <div className="flex items-center gap-2 font-semibold">
          <Bot className="h-4 w-4 text-primary" /> ZAIPOS AI
          <span className="pill pill-warn ml-auto">Read-only safety mode</span>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          Autonomous ordering and operational mutation tools are disabled for P0. Existing configuration and
          knowledge records are preserved, but they are not used to produce live business claims or actions.
        </p>
      </div>

      <div className="glass grid gap-4 p-5 md:grid-cols-2">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-medium">Evidence required</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Operational facts will remain unavailable until tenant-scoped read tools return source metadata.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 text-primary" />
          <div>
            <div className="font-medium">Writes blocked</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Database grants and the edge controller deny AI-created orders and other hidden mutations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
