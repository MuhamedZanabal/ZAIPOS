-- P0 SEC-004 Stage 6: make device enrollment revocation atomically invalidate
-- every outstanding offline lease for the same physical terminal.
BEGIN;

CREATE OR REPLACE FUNCTION public.revoke_device_enrollment(
  _tenant_id uuid,
  _device_id uuid,
  _reason text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor uuid := auth.uid();
  _device public.devices%ROWTYPE;
  _normalized_reason text := btrim(COALESCE(_reason, ''));
  _revoked_lease_count integer := 0;
  _revoked_at timestamptz := clock_timestamp();
BEGIN
  IF _actor IS NULL OR _tenant_id IS NULL OR _device_id IS NULL
     OR char_length(_normalized_reason) NOT BETWEEN 4 AND 256 THEN
    RAISE EXCEPTION 'Not authorized to revoke device enrollment'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _device
  FROM public.devices d
  WHERE d.id = _device_id
    AND d.tenant_id = _tenant_id
  FOR UPDATE;

  IF NOT FOUND OR _device.branch_id IS NULL
     OR NOT public.has_branch_role(
       _actor,
       _tenant_id,
       _device.branch_id,
       ARRAY['owner', 'admin', 'manager']::public.app_role[]
     ) OR NOT EXISTS (
       SELECT 1
       FROM auth.users u
       WHERE u.id = _actor
         AND u.deleted_at IS NULL
         AND (u.banned_until IS NULL OR u.banned_until <= now())
     ) OR EXISTS (
       SELECT 1
       FROM public.employees e
       WHERE e.user_id = _actor
         AND e.tenant_id = _tenant_id
         AND (e.branch_id IS NULL OR e.branch_id = _device.branch_id)
         AND e.status = 'inactive'
     ) THEN
    RAISE EXCEPTION 'Not authorized to revoke device enrollment'
      USING ERRCODE = '42501';
  END IF;

  IF _device.revoked_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.devices
  SET revoked_at = _revoked_at,
      revoked_by = _actor,
      revocation_reason = _normalized_reason,
      credential_hash = NULL,
      updated_at = _revoked_at
  WHERE id = _device.id;

  -- This update is deliberately in the same transaction as device revocation.
  -- A failure rolls the whole revocation back; a successful revocation cannot
  -- leave server-recognized offline authority active for the revoked terminal.
  UPDATE public.device_offline_leases
  SET revoked_at = _revoked_at,
      revoke_reason = 'device_revoked'
  WHERE device_id = _device.id
    AND revoked_at IS NULL;
  GET DIAGNOSTICS _revoked_lease_count = ROW_COUNT;

  INSERT INTO public.audit_logs
    (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    _tenant_id,
    _actor,
    'device.enrollment_revoked',
    'device_enrollment',
    _device.id,
    jsonb_build_object(
      'branch_id', _device.branch_id,
      'device_uid', _device.device_uid,
      'reason', _normalized_reason,
      'credential_invalidated', true,
      'offline_leases_invalidated', _revoked_lease_count
    )
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_device_enrollment(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_device_enrollment(uuid, uuid, text)
  TO authenticated;

COMMENT ON FUNCTION public.revoke_device_enrollment(uuid, uuid, text) IS
  'Manager-only, branch-scoped, replay-safe terminal revocation with atomic credential and outstanding offline-lease invalidation plus immutable audit evidence.';

COMMIT;
