CREATE SCHEMA IF NOT EXISTS cron;

CREATE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint
LANGUAGE sql
AS $$ SELECT 0::bigint $$;

CREATE FUNCTION cron.unschedule(job_name text)
RETURNS boolean
LANGUAGE sql
AS $$ SELECT true $$;
