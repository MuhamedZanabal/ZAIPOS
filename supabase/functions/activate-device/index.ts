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
    const appVersion = typeof body?.app_version === "string" ? body.app_version.trim() : "";
    const os = typeof body?.os === "string" ? body.os.trim() : "";
    if (!approvalId || !deviceUid || !appVersion || !os || deviceUid.length > 128 || appVersion.length > 64 || os.length > 64) {
      return json({ error: "Invalid activation request" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: approval, error: approvalError } = await admin
      .from("device_enrollment_approvals")
      .select("id,tenant_id,branch_id,device_uid,approved_by,consumed_at,expires_at")
      .eq("id", approvalId)
      .maybeSingle();
    if (approvalError) return json({ error: "Activation authority unavailable" }, 500);
    if (!approval || approval.approved_by !== userData.user.id || approval.device_uid !== deviceUid || approval.consumed_at || Date.parse(approval.expires_at) <= Date.now()) {
      return json({ error: "Activation approval rejected" }, 403);
    }

    const { data: roleRows, error: roleError } = await admin.from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("tenant_id", approval.tenant_id)
      .eq("branch_id", approval.branch_id)
      .in("role", ["owner", "admin", "manager"]);
    if (roleError) return json({ error: "Activation authority unavailable" }, 500);
    if (!roleRows?.length) return json({ error: "Activation approval rejected" }, 403);

    const { data, error } = await admin.rpc("activate_device_enrollment", {
      _approval_id: approvalId,
      _app_version: appVersion,
      _os: os,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return json({ error: "Device activation failed" }, 400);
    const row = data[0] as { device_id: string; device_uid: string; credential: string };
    if (row.device_uid !== deviceUid || !/^[0-9a-f]{64}$/i.test(row.credential)) return json({ error: "Device activation response rejected" }, 500);
    return json(row);
  } catch {
    return json({ error: "Unexpected activation failure" }, 500);
  }
});
