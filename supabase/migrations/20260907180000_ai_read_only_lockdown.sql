-- P0 AI safety: remove the legacy autonomous tool surface.
-- Future read/action tools must be introduced through separately reviewed,
-- tenant-scoped server commands with evidence and approval policies.

BEGIN;

REVOKE ALL ON FUNCTION public.ai_search_catalog(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_quote_order(uuid, uuid, jsonb, public.sales_channel)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_create_digital_order(uuid, uuid, uuid, jsonb, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ai_handoff_to_human(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
