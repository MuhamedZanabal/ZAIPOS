import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ROLES = ["owner", "admin", "manager", "cashier", "kitchen", "inventory", "staff", "waiter", "courier"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return json({ error: "Missing Authorization" }, 401);
    }

    // Identify caller
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: uErr } = await userClient.auth.getUser();
    if (uErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
    const callerId = userData.user.id;

    const body = await req.json();
    const { email, password, full_name, role, tenant_id, branch_id } = body ?? {};

    if (!email || !password || !role || !tenant_id) {
      return json({ error: "email, password, role y tenant_id son requeridos" }, 400);
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return json({ error: "Rol inválido" }, 400);
    }
    if (String(password).length < 6) {
      return json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: activeCaller, error: activeCallerError } = await admin.rpc("is_active_auth_user", {
      _user_id: callerId,
    });
    if (activeCallerError) return json({ error: "Unable to verify account state" }, 500);
    if (activeCaller !== true) return json({ error: "Forbidden" }, 403);

    // Verify caller is owner/admin of that tenant
    const { data: callerRoles, error: rErr } = await admin
      .from("user_roles")
      .select("role,branch_id")
      .eq("user_id", callerId)
      .eq("tenant_id", tenant_id);
    if (rErr) return json({ error: rErr.message }, 500);
    const isAdmin = (callerRoles ?? []).some((r: any) => {
      if (r.role === "super_admin") return true;
      if (!["owner", "admin"].includes(r.role)) return false;
      if (r.branch_id === null || r.branch_id === undefined) return true;
      return branch_id !== null && branch_id !== undefined && r.branch_id === branch_id;
    });
    if (!isAdmin) return json({ error: "Forbidden: owner/admin scope does not authorize this branch" }, 403);

    if (branch_id !== null && branch_id !== undefined) {
      const { data: branch, error: branchError } = await admin
        .from("branches")
        .select("id")
        .eq("id", branch_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      if (branchError) return json({ error: "Unable to verify branch authorization" }, 500);
      if (!branch) return json({ error: "Forbidden: branch does not belong to tenant" }, 403);
    }

    // Check existing profile by email
    const { data: existingProfile } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", email)
      .maybeSingle();

    let newUserId: string;
    if (existingProfile?.id) {
      newUserId = existingProfile.id;
    } else {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: full_name ?? email },
      });
      if (cErr || !created?.user) return json({ error: cErr?.message ?? "No se pudo crear el user" }, 400);
      newUserId = created.user.id;
    }

    // Already a member with this role?
    const { data: existingRole } = await admin
      .from("user_roles")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("user_id", newUserId)
      .eq("role", role)
      .maybeSingle();
    if (existingRole) {
      return json({ error: "El user ya tiene este rol asignado" }, 409);
    }

    const { error: insErr } = await admin
      .from("user_roles")
      .insert({ tenant_id, user_id: newUserId, role, branch_id: branch_id ?? null });
    if (insErr) return json({ error: insErr.message }, 500);

    return json({ user_id: newUserId, email });
  } catch (e: any) {
    return json({ error: e?.message ?? "Unexpected error" }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
