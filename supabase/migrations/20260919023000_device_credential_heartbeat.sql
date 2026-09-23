-- SEC-004 Stage 3: credential possession is required for device heartbeat.
-- The registry identity is TEXT by design. All historical UID-only heartbeat
-- entry points are deliberately fail-closed so an authenticated renderer cannot
-- self-enroll a replacement terminal after revocation.

-- Preserve a small legacy overload as an explicit fail-closed guard for callers
-- that were introduced during the staged authority migration.
CREATE OR REPLACE FUNCTION public.register_device_heartbeat(
  p_device_uid text,
  p_device_name text,
  p_branch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'device credential required' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(text, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- Replace the original fleet-registry heartbeat as fail-closed. This signature
-- previously accepted tenant/branch/UID metadata and could INSERT a new device,
-- which is exactly the SEC-004 replacement-UID bypass.
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
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'device credential required' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(uuid, uuid, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

-- Credential-bound heartbeat. Tenant authority is derived from the enrolled
-- device row, then cross-checked against the authenticated operator's branch
-- role. The caller cannot choose or rewrite the device tenant/branch.
CREATE OR REPLACE FUNCTION public.register_device_heartbeat(
  p_device_uid text,
  p_device_name text,
  p_branch_id uuid,
  p_device_credential text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_device public.devices%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_device_uid IS NULL OR char_length(btrim(p_device_uid)) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid device identity' USING ERRCODE = '42501';
  END IF;
  IF p_device_credential IS NULL
     OR length(p_device_credential) <> 64
     OR p_device_credential !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid device credential' USING ERRCODE = '42501';
  END IF;

  SELECT d.* INTO v_device
  FROM public.devices d
  WHERE d.device_uid = btrim(p_device_uid)
    AND d.branch_id = p_branch_id
    AND d.revoked_at IS NULL
    AND d.credential_hash = extensions.digest(convert_to(p_device_credential, 'UTF8'), 'sha256')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'device credential rejected' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_branch_role(
    v_user_id,
    v_device.tenant_id,
    v_device.branch_id,
    ARRAY['owner','admin','manager','cashier','kitchen','inventory','staff','waiter','courier']::public.app_role[]
  ) THEN
    RAISE EXCEPTION 'device operator is not authorized for this branch' USING ERRCODE = '42501';
  END IF;

  UPDATE public.devices
  SET last_seen_at = now(), updated_at = now()
  WHERE id = v_device.id;
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(text, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_heartbeat(text, text, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.register_device_heartbeat(text, text, uuid, text) IS
  'Authenticated heartbeat requiring possession of the activated device credential; tenant and branch are derived from enrolled device authority.';
