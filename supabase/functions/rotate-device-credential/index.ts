import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authorization = request.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return json({ error: "Not authenticated" }, 401);

    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authorization } } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Not authenticated" }, 401);

    const body = await request.json();
    const approvalId = typeof body?.approval_id === "string" ? body.approval_id : "";
    const deviceUid = typeof body?.device_uid === "string" ? body.device_uid.trim() : "";
    if (!approvalId || !deviceUid || deviceUid.length > 128) return json({ error: "Invalid rotation request" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: approval, error: approvalError } = await admin
      .from("device_credential_rotation_approvals")
      .select("id,tenant_id,branch_id,device_id,approved_by,consumed_at,expires_at,devices!inner(device_uid)")
      .eq("id", approvalId)
      .maybeSingle();
    if (approvalError) return json({ error: "Rotation authority unavailable" }, 500);
    const approvedDeviceUid = Array.isArray(approval?.devices) ? approval?.devices[0]?.device_uid : approval?.devices?.device_uid;
    if (!approval || approval.approved_by !== userData.user.id || approvedDeviceUid !== deviceUid || approval.consumed_at || Date.parse(approval.expires_at) <= Date.now()) {
      return json({ error: "Rotation approval rejected" }, 403);
    }

    const { data: allowed, error: roleError } = await admin.rpc("has_branch_role", {
      _user_id: userData.user.id,
      _tenant_id: approval.tenant_id,
      _branch_id: approval.branch_id,
      _roles: ["owner", "admin", "manager"],
    });
    if (roleError) return json({ error: "Rotation authority unavailable" }, 500);
    if (!allowed) return json({ error: "Rotation approval rejected" }, 403);

    const { data, error } = await admin.rpc("rotate_device_credential", { _approval_id: approvalId });
    if (error || !Array.isArray(data) || data.length !== 1) return json({ error: "Device credential rotation failed" }, 400);
    const row = data[0] as { device_id: string; device_uid: string; credential: string };
    if (row.device_id !== approval.device_id || row.device_uid !== deviceUid || !/^[0-9a-f]{64}$/i.test(row.credential)) {
      return json({ error: "Device credential rotation response rejected" }, 500);
    }
    return json(row);
  } catch {
    return json({ error: "Unexpected credential rotation failure" }, 500);
  }
});
