import { useCallback, useEffect, useState } from "react";
import { Loader2, Settings2 } from "lucide-react";
import { useTenantByDomain } from "@/hooks/useTenantByDomain";
import { supabase } from "@/integrations/supabase/client";
import { signOutFully } from "@/lib/signOut";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Session } from "@supabase/supabase-js";

interface TenantProviderProps {
  children: React.ReactNode;
}

function UnconfiguredScreen() {
  const hostname = window.location.hostname;
  const [session, setSession] = useState<Session | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [tenants, setTenants] = useState<{ id: string; name: string; slug: string; domain: string | null }[]>([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [saving, setSaving] = useState(false);

  const loadTenants = useCallback(async () => {
    const { data } = await supabase.from("tenants").select("id, name, slug, domain");
    setTenants(data ?? []);
  }, []);

  const checkSuperAdmin = useCallback(async (userId: string) => {
    setAuthLoading(true);
    const { data } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "super_admin")
      .maybeSingle();

    const isAdmin = !!data;
    setIsSuperAdmin(isAdmin);
    setAuthLoading(false);
    if (isAdmin) loadTenants();
  }, [loadTenants]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      if (data.session) checkSuperAdmin(data.session.user.id);
      else setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) checkSuperAdmin(nextSession.user.id);
      else {
        setIsSuperAdmin(false);
        setAuthLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [checkSuperAdmin]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoggingIn(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) toast.error(error.message);
    setLoggingIn(false);
  }

  async function handleSetDomain() {
    if (!selectedTenant) return;
    setSaving(true);
    const { error } = await supabase
      .from("tenants")
      .update({ domain: hostname })
      .eq("id", selectedTenant);

    if (error) {
      toast.error(`Error: ${error.message}`);
    } else {
      toast.success("Domain configured. Reloading...");
      setTimeout(() => window.location.reload(), 800);
    }
    setSaving(false);
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (session && isSuperAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex items-center gap-2 text-amber-600">
            <Settings2 className="h-5 w-5" />
            <span className="font-semibold text-sm">Configure instance</span>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Detected hostname</p>
            <code className="block text-sm font-mono bg-muted px-3 py-2 rounded">{hostname}</code>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Link to business</label>
            <select
              aria-label="Business"
              className="w-full border rounded px-3 py-2 text-sm bg-background"
              value={selectedTenant}
              onChange={(event) => setSelectedTenant(event.target.value)}
            >
              <option value="">Select business...</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.slug}){tenant.domain ? ` — ${tenant.domain}` : ""}
                </option>
              ))}
            </select>
          </div>

          <Button className="w-full" disabled={!selectedTenant || saving} onClick={handleSetDomain}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Link domain and continue"}
          </Button>

          <Button variant="ghost" className="w-full text-xs text-muted-foreground" onClick={() => signOutFully()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Instance not configured</h1>
          <p className="text-muted-foreground text-xs">
            No business is linked to <code className="font-mono">{hostname}</code>.
          </p>
        </div>

        {session && !isSuperAdmin ? (
          <p className="text-center text-xs text-destructive">
            Your account does not have permission to configure this instance.
          </p>
        ) : (
          <form onSubmit={handleLogin} className="space-y-3">
            <p className="text-xs text-muted-foreground text-center">
              Sign in as a super administrator to configure it.
            </p>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-background"
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full border rounded px-3 py-2 text-sm bg-background"
              required
            />
            <Button type="submit" className="w-full" disabled={loggingIn}>
              {loggingIn ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

export function TenantProvider({ children }: TenantProviderProps) {
  const { loading, error } = useTenantByDomain();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error === "not-found") return <UnconfiguredScreen />;

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-2 px-4">
          <h1 className="text-xl font-semibold text-foreground">Connection error</h1>
          <p className="text-muted-foreground text-sm">
            Could not reach the server. Try reloading the page.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
