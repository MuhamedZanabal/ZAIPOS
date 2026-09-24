import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-1.5-flash";
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = 8 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_REQUEST_BYTES) {
      return json({ error: "Invoice payload too large" }, 413);
    }

    const body = await req.json().catch(() => null);
    const image = typeof body?.image === "string" ? body.image : "";
    const mime_type = typeof body?.mime_type === "string" ? body.mime_type.toLowerCase() : "image/jpeg";
    const tenant_id = typeof body?.tenant_id === "string" ? body.tenant_id : "";
    const branch_id = typeof body?.branch_id === "string" ? body.branch_id : "";
    if (!image || !tenant_id || !branch_id) {
      return json({ error: "image, tenant_id and branch_id are required" }, 400);
    }
    if (!ALLOWED_MIME_TYPES.has(mime_type) || image.length > MAX_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image)) {
      return json({ error: "Invalid invoice media" }, image.length > MAX_BASE64_CHARS ? 413 : 400);
    }

    const { data: allowed, error: roleErr } = await supabase.rpc("has_branch_role", {
      _user_id: user.id,
      _tenant_id: tenant_id,
      _branch_id: branch_id,
      _roles: ["owner", "admin", "manager", "inventory"],
    });
    if (roleErr || !allowed) return json({ error: "Forbidden" }, 403);
    if (!GEMINI_API_KEY) return json({ error: "Invoice processor unavailable" }, 503);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "Analyze this supplier invoice. Return strict JSON: { \"products\": [{ \"name\": \"string\", \"quantity\": number, \"unit_price\": number, \"total\": number }] }. Use pre-tax unit prices." },
              { inline_data: { mime_type, data: image } },
            ],
          }],
          generationConfig: { response_mime_type: "application/json" },
        }),
      },
    );
    if (!response.ok) return json({ error: "Invoice provider unavailable" }, 502);

    const result = await response.json().catch(() => null);
    const textResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof textResponse !== "string") return json({ error: "Invoice provider returned invalid output" }, 502);
    const parsed = JSON.parse(textResponse);
    return json(parsed);
  } catch {
    return json({ error: "Invoice processing failed" }, 500);
  }
});
