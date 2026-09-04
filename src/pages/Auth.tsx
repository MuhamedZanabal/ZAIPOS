import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GearMark } from "@/components/shared/GearMark";
import { LiveDot } from "@/components/shared/LiveDot";
import { toast } from "sonner";
import {
  Loader2, Shield, Zap, Wifi, ArrowLeft,
  ShoppingCart, UtensilsCrossed, BarChart3,
} from "lucide-react";

const FEATURES = [
  { icon: Zap, text: "Touch-first and fast · Tiles glow on press" },
  { icon: Wifi, text: "Offline-first · Automatic sync on reconnect" },
  { icon: Shield, text: "Multi-branch · Granular roles and channels" },
];

const PROOF = [
  { icon: ShoppingCart, label: "Sales processed", value: "Unlimited" },
  { icon: UtensilsCrossed, label: "Integrated channels", value: "5+" },
  { icon: BarChart3, label: "Real-time reports", value: "Always" },
];

export default function Auth() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    document.title = "Sign in | ZAIPOS";
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      toast.success("Welcome back");
      navigate("/dashboard", { replace: true });
    } catch (err: any) {
      toast.error(err.message ?? "Authentication error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-background">
      <div className="hidden lg:flex lg:w-[52%] xl:w-[55%] flex-col relative overflow-hidden auth-panel-left">
        <div className="absolute inset-0 s-grid-texture pointer-events-none opacity-50" />
        <div className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full pointer-events-none auth-glow-blue" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[400px] rounded-full pointer-events-none auth-glow-green" />
        <div className="absolute -bottom-20 -right-20 opacity-[0.04] pointer-events-none">
          <GearMark size={420} />
        </div>

        <div className="relative z-10 flex flex-col h-full p-12">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <GearMark size={34} />
              <div>
                <div className="auth-lockup-title">ZAIPOS</div>
                <div className="auth-lockup-sub">Bahrain Point of Sale</div>
              </div>
            </div>
            <Link to="/" className="auth-back-link">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to home
            </Link>
          </div>

          <div className="mt-6 self-start">
            <span className="s-pill s-pill-green inline-flex items-center gap-2">
              <LiveDot /> OPERATIONAL SYSTEM · BAHRAIN · v1.0
            </span>
          </div>

          <div className="mt-auto mb-auto pt-12">
            <h1 className="auth-hero-title">
              Run every sale through<br />
              <span className="gradient-text">one operating system.</span>
            </h1>
            <p className="auth-hero-sub">
              Multi-channel · Multi-branch · Offline-first.<br />
              From the counter to the courier, from the dining room to the dashboard.
            </p>

            <div className="mt-8 space-y-3.5">
              {FEATURES.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <div className="auth-feature-icon">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                  <p className="text-sm text-sidebar-foreground/70 leading-snug">{text}</p>
                </div>
              ))}
            </div>

            <div className="mt-10 pt-8 border-t border-sidebar-border/30 grid grid-cols-3 gap-4">
              {PROOF.map(({ icon: Icon, label, value }) => (
                <div key={label} className="text-center">
                  <Icon className="h-4 w-4 text-primary/60 mx-auto mb-1" />
                  <div className="text-base font-black text-sidebar-foreground">{value}</div>
                  <div className="text-[10px] text-sidebar-foreground/40 leading-snug mt-0.5">{label}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-sidebar-foreground/25 tracking-wider">
            © 2026 ZAIPOS Contributors · MIT
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6 sm:p-10 overflow-y-auto">
        <div className="w-full max-w-sm space-y-5">
          <div className="flex items-center justify-between lg:hidden">
            <div className="flex items-center gap-2.5">
              <GearMark size={28} />
              <div className="auth-lockup-title">ZAIPOS</div>
            </div>
            <Link to="/" className="auth-back-link">
              <ArrowLeft className="h-3.5 w-3.5" /> Home
            </Link>
          </div>

          <div className="glass p-7 rounded-3xl">
            <div className="mb-6">
              <div className="h-label g-auth-eyebrow mb-2">OPERATIONAL ACCESS</div>
              <div className="h-display g-auth-title">Sign in</div>
              <div className="h-meta mt-1">Sign in with your authorized ZAIPOS account.</div>
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  inputMode="email"
                  autoComplete="email"
                  className="h-11 text-base"
                  placeholder="user@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pwd" className="text-sm font-medium">Password</Label>
                <Input
                  id="pwd"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="current-password"
                  className="h-11 text-base"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="g-btn g-btn-primary g-btn-touch g-auth-submit w-full mt-2"
                disabled={loading}
              >
                {loading
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</>
                  : "Sign in to ZAIPOS"
                }
              </button>
            </form>
          </div>

          <div className="grid grid-cols-3 gap-3 lg:hidden">
            {PROOF.map(({ icon: Icon, label, value }) => (
              <div key={label} className="glass-thin rounded-2xl p-3 text-center">
                <Icon className="h-3.5 w-3.5 mx-auto mb-1 g-auth-proof-icon" />
                <div className="g-auth-proof-val leading-tight">{value}</div>
                <div className="h-meta g-auth-proof-lbl leading-tight mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-muted-foreground/50 text-center">
            Authorized access only · Report issues to your administrator
          </p>
        </div>
      </div>
    </div>
  );
}
