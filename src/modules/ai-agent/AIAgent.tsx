import { useState, useRef, useEffect } from "react";
import { useTenantContext } from "@/hooks/useTenantContext";
import { supabase } from "@/integrations/supabase/client";
import {
  Sparkles, Send, Plus, TrendingUp, Package, Users, Truck, Wallet,
  ArrowUpRight, CheckCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "ai";
  text: string;
  chart?: boolean;
  insights?: string[];
  actions?: string[];
}

const SUGGESTIONS = [
  "Today's sales by hour",
  "What supplies should I order this week?",
  "Top 10 customers this quarter",
  "Comparar sucursales",
];

const DATA_SOURCES = [
  { icon: TrendingUp, label: "POS Sales", sub: "transactions this month" },
  { icon: Package,   label: "Inventory",  sub: "active SKUs" },
  { icon: Users,     label: "Customer CRM", sub: "active customers" },
  { icon: Truck,     label: "Digital orders", sub: "Rappi · DiDi · Uber" },
  { icon: Wallet,    label: "Cash register and payments", sub: "sessions today" },
];

function AiOrb({ size = 34 }: { size?: number }) {
  const sizeClass = size >= 48 ? "g-ai-orb-50" : "g-ai-orb-34";
  const iconSize = Math.round(size * 0.47);
  return (
    <div className={`orb ${sizeClass}`}>
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="white">
        <path d="M12 2 L14 8 L20 9.5 L15.5 13 L17 19 L12 16 L7 19 L8.5 13 L4 9.5 L10 8 Z" />
      </svg>
    </div>
  );
}

function UserOrb({ initials }: { initials: string }) {
  return (
    <div className="g-topbar-avatar g-ai-user-orb">
      {initials}
    </div>
  );
}

function MarginBarChart() {
  const data = [
    { name: "Classic Cappuccino",     margin: 71 },
    { name: "Cheesecake de Fresa",   margin: 68 },
    { name: "Mocha Frappe",          margin: 64 },
    { name: "Croissant Mantequilla", margin: 58 },
    { name: "Latte Vainilla",        margin: 55 },
  ];
  return (
    <div className="glass-thin g-ai-chart-wrap">
      <div className="flex justify-between items-center mb-3">
        <span className="h-label">Gross margin by product · this month</span>
        <span className="h-meta">Source: sales + costs</span>
      </div>
      <div className="g-ai-margin-chart">
        {data.map((d, i) => (
          <div key={i} className="g-ai-margin-row">
            <span className="g-ai-margin-label">{d.name}</span>
            <div className="g-ai-margin-bar-track">
              <div className="g-ai-margin-bar-fill" {...{ style: { width: `${d.margin}%` } }} />
              <span className="g-ai-margin-pct">{d.margin}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AIAgent() {
  const { roles } = useTenantContext();
  const initials = (roles[0] ?? "U").slice(0, 2).toUpperCase();

  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "ai",
      text: "Hello, I'm the S360T Agent. I have access to your sales, inventory, customers, and more. How can I help you today?",
    },
  ]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing]);

  const send = async (text: string) => {
    if (!text.trim()) return;
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: text.trim() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setTyping(true);

    await new Promise((r) => setTimeout(r, 1400));
    setTyping(false);

    const lower = text.toLowerCase();
    let aiMsg: Message;
    if (lower.includes("margin") || lower.includes("product") || lower.includes("margen") || lower.includes("producto")) {
      aiMsg = {
        id: crypto.randomUUID(),
        role: "ai",
        text: "I analyzed this month's sales. These are the products with the highest gross margin:",
        chart: true,
        insights: [
          "The Classic Cappuccino has a 71% margin — an opportunity to promote a plant-based milk upsell.",
          "Strawberry Cheesecake has a high margin but low stock in some branches — consider a transfer.",
        ],
        actions: ["Create transfer", "Export report"],
      };
    } else if (lower.includes("sale") || lower.includes("today") || lower.includes("venta") || lower.includes("hoy")) {
      aiMsg = {
        id: crypto.randomUUID(),
        role: "ai",
        text: "You have active sales across all branches today. Peak demand occurs between 12:00 and 14:00. Check the Dashboard for full details.",
        actions: ["Ver dashboard", "Exportar Excel"],
      };
    } else {
      aiMsg = {
        id: crypto.randomUUID(),
        role: "ai",
        text: "Understood. I'm checking your business data to give you the most accurate answer possible. Can you give me more context about what you need?",
        actions: ["View sales", "View inventory"],
      };
    }

    setMessages((m) => [...m, aiMsg]);
  };

  return (
    <div className="g-ai-stage">
      {/* Chat column */}
      <div className="g-ai-chat-col">
        {/* Header */}
        <div className="glass g-ai-header">
          <AiOrb size={50} />
          <div className="g-ai-header-info">
            <div className="g-ai-header-title h-display">
              Agente S360T
              <span className="pill pill-brand g-kds-pill-micro">BETA</span>
            </div>
            <div className="h-meta">Connected to your inventory, sales, and CRM</div>
          </div>
          <div className="pill pill-ok">
            <span className="dot dot-ok" />
            Online
          </div>
        </div>

        {/* Messages */}
        <div className="g-ai-msgs">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end gap-2 items-end">
                <div className="g-ai-bubble-user">{m.text}</div>
                <UserOrb initials={initials} />
              </div>
            ) : (
              <div key={m.id} className="g-ai-bubble-ai">
                <AiOrb size={34} />
                <div className="glass-strong g-ai-bubble-ai-body">
                  <div className="g-ai-bubble-ai-text">{m.text}</div>
                  {m.chart && <MarginBarChart />}
                  {m.insights && (
                    <div className="flex flex-col gap-2">
                      {m.insights.map((s, i) => (
                        <div key={i} className="g-ai-insight">
                          <ArrowUpRight size={14} className="g-ai-insight-icon" />
                          <span className="g-ai-insight-text">{s}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {m.actions && (
                    <div className="flex gap-2 flex-wrap">
                      {m.actions.map((a, i) => (
                        <button key={i} type="button" className="g-btn g-btn-ghost g-btn-sm">
                          {a}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {typing && (
            <div className="g-ai-typing">
              <AiOrb size={34} />
              <div className="glass-thin g-ai-typing-bubble">
                <span className="g-ai-typing-dots">
                  <span className="dot dot-brand g-ai-dot-pulse" />
                  <span className="dot dot-brand g-ai-dot-mid" />
                  <span className="dot dot-brand g-ai-dot-dim" />
                </span>
                <span className="g-ai-typing-text">Consultando datos…</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Composer */}
        <div className="glass-strong g-ai-composer">
          <div className="g-ai-composer-row">
            <button type="button" title="Adjuntar archivo" className="g-btn g-btn-ghost g-ai-composer-btn-attach">
              <Plus size={16} />
            </button>
            <input
              className="g-ai-composer-placeholder bg-transparent border-none outline-none"
              placeholder="Ask the agent about sales, inventory, customers…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send(input))}
            />
            <button
              type="button"
              title="Send message"
              className="g-btn g-btn-primary g-ai-composer-btn-send"
              onClick={() => send(input)}
              disabled={!input.trim() || typing}
            >
              <Send size={15} />
            </button>
          </div>
          <div className="flex gap-2 flex-wrap">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i} type="button"
                className="pill pill-ghost pill-sm"
                onClick={() => send(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel */}
      <div className="g-ai-side">
        {/* Data sources */}
        <div className="glass g-ai-sources">
          <div className="h-display g-ai-section-title">Fuentes conectadas</div>
          {DATA_SOURCES.map(({ icon: Icon, label, sub }, i) => (
            <div key={i} className="g-ai-source-row">
              <div className="g-ai-source-icon">
                <Icon size={14} />
              </div>
              <div className="g-ai-source-info">
                <div className="g-ai-source-name">{label}</div>
                <div className="h-meta">{sub}</div>
              </div>
              <span className="dot dot-ok" />
            </div>
          ))}
        </div>

        {/* Recent actions */}
        <div className="glass g-ai-actions-panel">
          <div className="h-display g-ai-section-title">Acciones recientes</div>
          {[
            { l: "Weekly report sent", s: "Today · 4 recipients", ok: true },
            { l: "Critical stock alert",  s: "2 SKUs · South Branch",  ok: false },
          ].map((r, i) => (
            <div key={i} className="glass-thin g-ai-action-row">
              <span className={cn("dot", r.ok ? "dot-ok" : "dot-warn")} />
              <div className="g-ai-source-info">
                <div className="g-ai-source-name">{r.l}</div>
                <div className="h-meta">{r.s}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="glass-thin g-ai-privacy-note">
          El agente accede solo a datos de tu tenant. Las consultas se registran en <code>audit_logs</code> y nunca salen de tu instancia.
        </div>
      </div>
    </div>
  );
}
