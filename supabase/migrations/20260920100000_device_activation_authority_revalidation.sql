-- Revalidate the human approval authority at the instant a privileged service
-- caller exchanges a pending approval for a device credential. Approval and
-- activation are separate requests, so a role removal, account ban, or employee
-- deactivation between them must fail closed.
BEGIN;

CREATE OR REPLACE FUNCTION public.activate_device_enrollment(
  _approval_id uuid,
  _app_version text,
  _os text
) RETURNS TABLE(device_id uuid, device_uid text, credential text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _approval public.device_enrollment_approvals%ROWTYPE;
  _credential text;
  _device_id uuid;
BEGIN
  IF _approval_id IS NULL
     OR char_length(COALESCE(_app_version, '')) NOT BETWEEN 1 AND 64
     OR char_length(COALESCE(_os, '')) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'Invalid device activation request';
  END IF;

  SELECT * INTO _approval
  FROM public.device_enrollment_approvals
  WHERE id = _approval_id
  FOR UPDATE;

  IF NOT FOUND OR _approval.consumed_at IS NOT NULL OR _approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Device enrollment approval is invalid, expired, or consumed'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = _approval.approved_by
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= now())
  ) OR NOT public.has_branch_role(
    _approval.approved_by,
    _approval.tenant_id,
    _approval.branch_id,
    ARRAY['owner', 'admin', 'manager']::public.app_role[]
  ) OR EXISTS (
    SELECT 1
    FROM public.employees e
    WHERE e.user_id = _approval.approved_by
      AND e.tenant_id = _approval.tenant_id
      AND (e.branch_id IS NULL OR e.branch_id = _approval.branch_id)
      AND e.status = 'inactive'
  ) THEN
    RAISE EXCEPTION 'Device enrollment approver is no longer authorized'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _approval.branch_id
      AND b.tenant_id = _approval.tenant_id
      AND b.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Approved branch is no longer active' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.tenant_id = _approval.tenant_id
      AND d.device_uid = _approval.device_uid
  ) THEN
    RAISE EXCEPTION 'Device identity already exists; explicit rotation required'
      USING ERRCODE = '23505';
  END IF;

  _credential := encode(extensions.gen_random_bytes(32), 'hex');

  INSERT INTO public.devices (
    tenant_id, branch_id, device_uid, app_version, os,
    credential_hash, credential_issued_at
  ) VALUES (
    _approval.tenant_id, _approval.branch_id, _approval.device_uid,
    _app_version, _os, extensions.digest(_credential, 'sha256'), now()
  ) RETURNING id INTO _device_id;

  UPDATE public.device_enrollment_approvals
  SET consumed_at = now()
  WHERE id = _approval.id;

  INSERT INTO public.audit_logs
    (tenant_id, user_id, action, entity, metadata)
  VALUES (
    _approval.tenant_id, _approval.approved_by,
    'device.enrollment_activated', 'device_enrollment',
    jsonb_build_object(
      'approval_id', _approval.id,
      'device_id', _device_id,
      'branch_id', _approval.branch_id,
      'device_uid', _approval.device_uid,
      'credential_persisted', false,
      'approver_authority_revalidated', true
    )
  );

  RETURN QUERY SELECT _device_id, _approval.device_uid, _credential;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_device_enrollment(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_device_enrollment(uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.activate_device_enrollment(uuid, text, text) IS
  'Privileged single-use activation with activation-time approver revalidation; returns plaintext credential once and stores only its verifier.';

COMMIT;
