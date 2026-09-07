-- P0 terminal fleet registry and authenticated heartbeat command.
-- Application users can read authorized fleet state, but all device mutations
-- are forced through the scoped SECURITY DEFINER command below.

BEGIN;

CREATE TABLE public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  device_uid text NOT NULL CHECK (char_length(device_uid) BETWEEN 8 AND 200),
  app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 64),
  os text NOT NULL CHECK (char_length(os) BETWEEN 1 AND 64),
  update_channel text NOT NULL DEFAULT 'stable'
    CHECK (update_channel IN ('stable', 'beta')),
  update_state text NOT NULL DEFAULT 'current'
    CHECK (update_state IN ('current', 'outdated', 'update_available', 'downloading', 'ready', 'error')),
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'object'),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_tenant_device_uid_key UNIQUE (tenant_id, device_uid),
  CONSTRAINT devices_tenant_branch_fkey
    FOREIGN KEY (tenant_id, branch_id)
    REFERENCES public.branches(tenant_id, id)
);

CREATE INDEX devices_tenant_branch_last_seen_idx
  ON public.devices (tenant_id, branch_id, last_seen_at DESC);
CREATE INDEX devices_outdated_idx
  ON public.devices (tenant_id, update_state, last_seen_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY devices_manager_select
ON public.devices
FOR SELECT TO authenticated
USING (
  public.has_branch_role(
    auth.uid(),
    tenant_id,
    COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    ARRAY['owner','admin','manager']::public.app_role[]
  )
);

REVOKE ALL ON TABLE public.devices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.devices TO authenticated;

CREATE OR REPLACE FUNCTION public.register_device_heartbeat(
  _tenant_id uuid,
  _branch_id uuid,
  _device_uid text,
  _app_version text,
  _os text,
  _update_channel text DEFAULT 'stable',
  _update_state text DEFAULT 'current',
  _capabilities jsonb DEFAULT '{}'::jsonb
)
RETURNS public.devices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  result public.devices;
  existing_revoked_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF _branch_id IS NULL OR NOT public.has_branch_role(
    auth.uid(),
    _tenant_id,
    _branch_id,
    ARRAY['owner','admin','manager','cashier','kitchen','inventory','staff','waiter','courier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'Not authorized for this tenant and branch' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = _branch_id AND tenant_id = _tenant_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Active branch does not belong to tenant' USING ERRCODE = '23503';
  END IF;

  IF char_length(COALESCE(_device_uid, '')) NOT BETWEEN 8 AND 200
    OR char_length(COALESCE(_app_version, '')) NOT BETWEEN 1 AND 64
    OR char_length(COALESCE(_os, '')) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'Invalid device heartbeat identity';
  END IF;

  IF _update_channel NOT IN ('stable', 'beta')
    OR _update_state NOT IN ('current', 'outdated', 'update_available', 'downloading', 'ready', 'error')
    OR jsonb_typeof(COALESCE(_capabilities, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Invalid device heartbeat state';
  END IF;

  SELECT revoked_at
  INTO existing_revoked_at
  FROM public.devices
  WHERE tenant_id = _tenant_id AND device_uid = _device_uid
  FOR UPDATE;

  IF existing_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Device is revoked' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.devices (
    tenant_id,
    branch_id,
    device_uid,
    app_version,
    os,
    update_channel,
    update_state,
    capabilities,
    last_seen_at,
    updated_at
  ) VALUES (
    _tenant_id,
    _branch_id,
    _device_uid,
    _app_version,
    _os,
    _update_channel,
    _update_state,
    COALESCE(_capabilities, '{}'::jsonb),
    now(),
    now()
  )
  ON CONFLICT (tenant_id, device_uid) DO UPDATE SET
    branch_id = EXCLUDED.branch_id,
    app_version = EXCLUDED.app_version,
    os = EXCLUDED.os,
    update_channel = EXCLUDED.update_channel,
    update_state = EXCLUDED.update_state,
    capabilities = EXCLUDED.capabilities,
    last_seen_at = now(),
    updated_at = now()
  RETURNING * INTO result;

  RETURN result;
END
$function$;

REVOKE ALL ON FUNCTION public.register_device_heartbeat(uuid, uuid, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_heartbeat(uuid, uuid, text, text, text, text, text, jsonb)
  TO authenticated;

COMMIT;
