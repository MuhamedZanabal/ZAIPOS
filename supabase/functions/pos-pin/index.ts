import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.1";
import { hashPosPin, verifyPosPin } from "../_shared/pos-pin-crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

type PinRequest = {
  action?: "set" | "verify";
  tenant_id?: string;
  branch_id?: string;
  employee_id?: string;
  pin?: string;
  device_uid?: string;
  cash_session_id?: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function validUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization) return json({ error: "Authentication required" }, 401);

  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Authentication required" }, 401);

    const body = await request.json() as PinRequest;
    if (!validUuid(body.tenant_id) || !validUuid(body.branch_id)
      || !validUuid(body.employee_id) || !/^\d{4,8}$/u.test(body.pin ?? "")) {
      return json({ error: "Tenant, branch, employee and a 4–8 digit PIN are required" }, 400);
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (body.action === "set") {
      const pinHash = await hashPosPin(body.pin!);
      const { data, error } = await admin.rpc("set_employee_pos_pin_v1", {
        _actor_user_id: userData.user.id,
        _tenant_id: body.tenant_id,
        _branch_id: body.branch_id,
        _employee_id: body.employee_id,
        _pin_hash: pinHash,
        _operation_id: crypto.randomUUID(),
      });
      if (error) return json({ error: error.message }, error.code === "42501" ? 403 : 400);
      return json({ employee_id: body.employee_id, credential_id: data, algorithm: "argon2id" });
    }

    if (body.action !== "verify" || typeof body.device_uid !== "string"
      || body.device_uid.trim().length < 8
      || (body.cash_session_id != null && !validUuid(body.cash_session_id))) {
      return json({ error: "A registered device and valid session context are required" }, 400);
    }

    const { data: prepared, error: prepareError } = await admin.rpc(
      "begin_employee_pos_pin_verification_v1",
      {
        _actor_user_id: userData.user.id,
        _tenant_id: body.tenant_id,
        _branch_id: body.branch_id,
        _employee_id: body.employee_id,
        _device_uid: body.device_uid.trim(),
        _cash_session_id: body.cash_session_id ?? null,
        _operation_id: crypto.randomUUID(),
      },
    );
    if (prepareError) return json({ error: prepareError.message }, prepareError.code === "42501" ? 403 : 400);
    if (!prepared?.allowed) {
      return json({ error: "POS PIN is temporarily locked", locked_until: prepared?.locked_until }, 423);
    }

    let verified = false;
    let replacementHash: string | null = null;
    try {
      if (typeof prepared.pin_hash === "string") {
        verified = await verifyPosPin(prepared.pin_hash, body.pin!);
      } else if (typeof prepared.legacy_pin === "string") {
        verified = constantTimeTextEqual(prepared.legacy_pin, body.pin!);
        if (verified) replacementHash = await hashPosPin(body.pin!);
      }
    } catch {
      verified = false;
    }

    const { data: result, error: completeError } = await admin.rpc(
      "complete_employee_pos_pin_verification_v1",
      {
        _actor_user_id: userData.user.id,
        _attempt_id: prepared.attempt_id,
        _verified: verified,
        _replacement_hash: replacementHash,
      },
    );
    if (completeError) return json({ error: completeError.message }, 400);
    return json(result, result?.verified ? 200 : 401);
  } catch {
    return json({ error: "POS PIN request failed" }, 500);
  }
});
