-- Restaurant checkout must not be executable directly from renderer-held
-- authenticated Supabase sessions. Keep both legacy implementations callable
-- only from privileged server-side functions until the separately tested
-- native trusted-device checkout endpoint is implemented.
--
-- This intentionally leaves restaurant settlement unavailable in the current
-- renderer: the existing queue cutover fails closed. Do not enable checkout
-- or merge this partial security stack as a complete feature.
BEGIN;

REVOKE ALL ON FUNCTION public.checkout_table_order(uuid, jsonb, numeric, numeric, text, text)
  FROM PUBLIC, anon, authenticated;

COMMIT;
