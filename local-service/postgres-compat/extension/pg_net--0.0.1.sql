CREATE SCHEMA IF NOT EXISTS net;

CREATE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 1000
) RETURNS bigint
LANGUAGE sql
AS $$ SELECT 0::bigint $$;
