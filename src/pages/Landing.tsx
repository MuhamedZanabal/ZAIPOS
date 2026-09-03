import { Link, Navigate } from "react-router-dom";
import { GearMark } from "@/components/shared/GearMark";
import { LiveDot } from "@/components/shared/LiveDot";
import { useAuth } from "@/hooks/useAuth";
import { Loader2 } from "lucide-react";
import {
  ShoppingCart, UtensilsCrossed, BarChart3, Wifi, Zap, Shield,
  Bike, ChefHat, Smartphone, Package, Receipt, TrendingUp,
  CheckCircle, ArrowRight, Star,
} from "lucide-react";

/* ── Features ── */
const FEATURES = [
  {
    icon: ShoppingCart,
    sc: "sc-blue",
    title: "Touchscreen POS terminal",
    desc: "Visual catalog by category, EAN search, ticket management, and multi-method checkout on one screen.",
  },
  {
    icon: UtensilsCrossed,
    sc: "sc-green",
    title: "Tables & orders",
    desc: "Table ordering, real-time status, kitchen dispatch, and checkout from the dining room.",
  },
  {
    icon: Bike,
    sc: "sc-purple",
    title: "In-house delivery",
    desc: "Kanban delivery board, courier assignment, and status tracking.",
  },
  {
    icon: Smartphone,
    sc: "sc-amber",
    title: "Digital orders",
    desc: "Integration with Rappi, DiDi, Uber Eats, and WhatsApp. Real-time webhooks, commissions, and net revenue calculation.",
  },
  {
    icon: ChefHat,
    sc: "sc-cyan",
    title: "KDS · Cocina",
    desc: "Kitchen display with timing alerts, urgency colors, and item-by-item dispatch control.",
  },
  {
    icon: Package,
    sc: "sc-lime",
    title: "Inventory & production",
    desc: "Branch-level stock, movements, waste, recipes, and production. Automatic low-stock alerts.",
  },
  {
    icon: BarChart3,
    sc: "sc-rose",
    title: "Advanced reports",
    desc: "Daily sales, top products, payment-method mix, VAT, and CSV export.",
  },
  {
    icon: Wifi,
    sc: "sc-slate",
    title: "Offline-first",
    desc: "Works without internet. Automatically syncs when the connection returns. Installable PWA.",
  },
];

/* ── Stats ── */
const STATS = [
  { value: "5", unit: "canales", label: "de venta integrados" },
  { value: "∞", unit: "branches", label: "multi-branch" },
  { value: "100%", unit: "offline", label: "without losing a ticket" },
  { value: "8", unit: "roles", label: "de acceso granular" },
];

/* ── Plans ── */
const PLANS = [
  {
    name: "Starter",
    price: "Gratis",
    sub: "Para empezar",
    features: ["1 branch", "Terminal POS", "Cash register & sales", "Basic reports"],
    cta: "Comenzar gratis",
    accent: false,
  },
  {
    name: "Pro",
    price: "$149k",
    sub: "COP / mes",
    features: ["Unlimited branches", "Everything in Starter +", "Tables & orders", "Delivery & KDS", "Digital orders", "WhatsApp AI", "Advanced inventory"],
    cta: "Start 14-day free trial",
    accent: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    sub: "Custom quote",
    features: ["Todo Pro +", "SLA garantizado", "Onboarding dedicado", "Integraciones a medida"],
    cta: "Talk to sales",
    accent: false,
  },
];

export default function Landing() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">

      {/* ── Topbar ────────────────────────────────────────────── */}
      <header className="landing-topbar">
        <div className="landing-container flex items-center justify-between h-full">
          <div className="flex items-center gap-2.5">
            <GearMark size={28} />
            <span className="landing-logo-text">
              POS<span className="c-blue">360</span><span className="c-green">T</span>
            </span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Funciones</a>
            <a href="#planes" className="hover:text-foreground transition-colors">Planes</a>
            <a href="#contacto" className="hover:text-foreground transition-colors">Contacto</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link to="/auth" className="text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
              Sign in
            </Link>
            <Link to="/auth" className="landing-btn-primary">
              Empezar gratis <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="landing-hero">
        {/* Background glows */}
        <div className="landing-glow-blue" />
        <div className="landing-glow-green" />
        <div className="absolute inset-0 s-grid-texture opacity-40 pointer-events-none" />

        {/* Gear watermark */}
        <div className="absolute -bottom-20 -right-20 opacity-[0.04] pointer-events-none hidden lg:block">
          <GearMark size={480} />
        </div>

        <div className="landing-container relative z-10 text-center">
          {/* Pill */}
          <div className="inline-flex items-center gap-2 s-pill s-pill-green mb-6">
            <LiveDot /> SISTEMA POS · S360T · v1.0
          </div>

          {/* Headline */}
          <h1 className="landing-hero-title">
            Tu venta como<br />
            <span className="gradient-text">sistema operativo.</span>
          </h1>

          <p className="landing-hero-sub">
            Multi-channel · Multi-branch · Offline-first.<br className="hidden sm:block" />
            From the counter to the courier, from the dining room to the dashboard.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
            <Link to="/auth" className="landing-btn-primary landing-btn-lg">
              Start free — no card required <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#features" className="landing-btn-ghost landing-btn-lg">
              Ver funciones
            </a>
          </div>

          {/* Social proof */}
          <div className="flex items-center justify-center gap-6 mt-10 text-sm text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-primary" /> No card required</span>
            <span className="flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-primary" /> 14 days free</span>
            <span className="flex items-center gap-1.5"><CheckCircle className="h-4 w-4 text-primary" /> Cancela cuando quieras</span>
          </div>
        </div>
      </section>

      {/* ── Stats bar ─────────────────────────────────────────── */}
      <section className="landing-stats-bar">
        <div className="landing-container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-0 md:divide-x divide-border">
            {STATS.map(({ value, unit, label }) => (
              <div key={label} className="text-center px-6 py-4">
                <div className="landing-stat-value">{value} <span className="c-blue text-2xl">{unit}</span></div>
                <div className="text-sm text-muted-foreground mt-1">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────── */}
      <section id="features" className="landing-section">
        <div className="landing-container">
          <div className="text-center mb-12">
            <div className="eyebrow eyebrow-blue mb-3">FUNCIONALIDADES</div>
            <h2 className="landing-section-title">
              Everything your business needs,<br />
              <span className="gradient-text">en una sola plataforma.</span>
            </h2>
            <p className="landing-section-sub">
              From the cash register to inventory and digital orders.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map(({ icon: Icon, sc, title, desc }) => (
              <div key={title} className="landing-feature-card">
                <div className={`landing-feature-icon ${sc} sc-icon-bg`}>
                  <Icon className="h-5 w-5 sc-icon-color" strokeWidth={1.75} />
                </div>
                <h3 className="font-semibold text-base mt-4 mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Highlight row ─────────────────────────────────────── */}
      <section className="landing-section landing-highlight">
        <div className="landing-container">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            {/* Left copy */}
            <div>
              <div className="eyebrow eyebrow-blue mb-3">BRANDING BRUTAL</div>
              <h2 className="landing-section-title mb-4">
                Tres dispositivos,<br />
                <span className="gradient-text">un solo lenguaje.</span>
              </h2>
              <p className="text-muted-foreground leading-relaxed mb-6">
                Deep navy, action blue, and signal green. 100×100+ tiles with glow on press,
                tracked uppercase eyebrows and a gradient highlight on the key title.
                Pensado para tocar, mirar y operar.
              </p>
              <ul className="space-y-3">
                {[
                  { label: "Tablet · Terminal POS",        sub: "Catalog + ticket + checkout on one screen" },
                  { label: "Mobile · Waiter / Courier",  sub: "Table status, orders, delivery"   },
                  { label: "Desktop · Operations Dashboard", sub: "KPIs, live feed, KDS, and reports"       },
                ].map(({ label, sub }) => (
                  <li key={label} className="flex items-start gap-3">
                    <div className="h-5 w-5 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0 mt-0.5">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                    <div>
                      <span className="font-semibold text-sm">{label}</span>
                      <p className="text-xs text-muted-foreground">{sub}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <Link to="/auth" className="landing-btn-primary landing-btn-lg mt-8 inline-flex">
                Ver demo <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            {/* Right: mock screens */}
            <div className="relative">
              {/* Desktop card */}
              <div className="landing-mock-card">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-warning/70" />
                  <div className="h-2.5 w-2.5 rounded-full bg-success/70" />
                  <div className="flex-1 h-5 rounded bg-muted/60 mx-2" />
                </div>
                <div className="flex gap-3">
                  {/* Sidebar mock */}
                  <div className="w-16 space-y-1.5 shrink-0">
                    <div className="h-7 rounded-lg bg-muted/80" />
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className={`h-5 rounded bg-muted/${i === 0 ? "100" : "40"}`} />
                    ))}
                  </div>
                  {/* Content mock */}
                  <div className="flex-1 space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      {[...Array(3)].map((_, i) => (
                        <div key={i} className="h-14 rounded-xl bg-muted/60 border border-border" />
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {[...Array(4)].map((_, i) => (
                        <div key={i} className="h-8 rounded bg-muted/40" />
                      ))}
                    </div>
                    <div className="h-20 rounded-xl bg-primary/10 border border-primary/20" />
                  </div>
                </div>
              </div>

              {/* Mobile card floating */}
              <div className="landing-mock-mobile">
                <div className="space-y-2">
                  <div className="h-16 rounded-xl bg-primary/15 border border-primary/20" />
                  <div className="grid grid-cols-2 gap-1.5">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className={`h-14 rounded-lg border ${i === 2 ? "bg-emerald-500/10 border-emerald-500/30" : "bg-muted/50 border-border"}`} />
                    ))}
                  </div>
                  <div className="h-8 rounded-lg bg-primary/80" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Planes ────────────────────────────────────────────── */}
      <section id="planes" className="landing-section">
        <div className="landing-container">
          <div className="text-center mb-12">
            <div className="eyebrow eyebrow-blue mb-3">PLANES Y PRECIOS</div>
            <h2 className="landing-section-title">
              Grow with <span className="gradient-text">your business.</span>
            </h2>
            <p className="landing-section-sub">No annual contracts. Cancel anytime.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {PLANS.map(({ name, price, sub, features, cta, accent }) => (
              <div key={name} className={`landing-plan-card ${accent ? "landing-plan-card-accent" : ""}`}>
                {accent && (
                  <div className="landing-plan-badge">
                    <Star className="h-3 w-3 fill-current" /> Most popular
                  </div>
                )}
                <div className="mb-6">
                  <div className="eyebrow mb-2">{name}</div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-black">{price}</span>
                    <span className="text-sm text-muted-foreground">{sub}</span>
                  </div>
                </div>
                <ul className="space-y-2.5 mb-8 flex-1">
                  {features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm">
                      <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/auth"
                  className={accent ? "landing-btn-primary w-full justify-center" : "landing-btn-ghost w-full justify-center"}
                >
                  {cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <section className="landing-section landing-cta-section">
        <div className="landing-container text-center relative z-10">
          <div className="eyebrow mb-4">READY TO GET STARTED?</div>
          <h2 className="landing-section-title mb-4">
            Start today —<br />
            <span className="gradient-text">free, no card required.</span>
          </h2>
          <p className="landing-section-sub mb-8">
            Set up your first business in under 5 minutes.
          </p>
          <Link to="/auth" className="landing-btn-primary landing-btn-lg">
            Crear cuenta gratis <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="landing-footer">
        <div className="landing-container">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <GearMark size={22} />
              <span className="font-semibold text-sm">
                POS<span className="c-blue">360</span><span className="c-green">T</span>
              </span>
              <span className="text-muted-foreground text-xs">· Open Source</span>
            </div>
            <p className="text-xs text-muted-foreground">© 2026 POS S360T Contributors · Apache 2.0</p>
            <Link to="/auth" className="text-sm font-semibold text-primary hover:underline">
              Sign in →
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
