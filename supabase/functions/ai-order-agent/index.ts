/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const P0_AI_MODE = 'read_only';

Deno.serve((request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return json({
    ok: true,
    skipped: 'p0_read_only_safety',
    mode: P0_AI_MODE,
    requires_human: true,
    message: 'Autonomous AI ordering is disabled until the secured action-control plane is available.',
  });
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
