-- Local identity and durable outbox. These tables do not reference hosted auth.
CREATE TABLE IF NOT EXISTS public.zaipos_local_users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, username),
  CONSTRAINT zaipos_local_users_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS public.zaipos_local_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  CONSTRAINT zaipos_local_devices_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS public.zaipos_local_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.zaipos_local_users(id),
  device_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.zaipos_outbox (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  branch_key text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zaipos_outbox_scope
  ON public.zaipos_outbox (tenant_id, branch_key, sequence);

CREATE TABLE IF NOT EXISTS public.zaipos_daily_sales (
  tenant_id text NOT NULL,
  day date NOT NULL,
  total_bhd numeric(14,3) NOT NULL,
  PRIMARY KEY (tenant_id, day)
);
