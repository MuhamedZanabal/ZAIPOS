-- P0 SEC-004: explicit credential rotation for an already-enrolled terminal.
-- Approval is branch-scoped and short-lived. Rotation is privileged, single-use,
-- invalidates the old verifier atomically, and never persists plaintext credentials.
BEGIN;

CREATE TABLE public.device_credential_rotation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES public.devices(id),
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz,
  CONSTRAINT device_credential_rotation_branch_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id),
  CONSTRAINT device_credential_rotation_expiry CHECK (expires_at > approved_at)
);

ALTER TABLE public.device_credential_rotation_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_credential_rotation_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.device_credential_rotation_approvals TO authenticated;

CREATE POLICY device_credential_rotation_manager_read
  ON public.device_credential_rotation_approvals FOR SELECT TO authenticated
  USING (public.has_branch_role(auth.uid(), tenant_id, branch_id,
    ARRAY['owner', 'admin', 'manager']::public.app_role[]));

CREATE OR REPLACE FUNCTION public.approve_device_credential_rotation(
  _tenant_id uuid,
  _device_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor uuid := auth.uid();
  _device public.devices%ROWTYPE;
  _approval_id uuid;
BEGIN
  IF _actor IS NULL OR _tenant_id IS NULL OR _device_id IS NULL THEN
    RAISE EXCEPTION 'Not authorized to approve device credential rotation'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _device
  FROM public.devices d
  WHERE d.id = _device_id
    AND d.tenant_id = _tenant_id
  FOR UPDATE;

  IF NOT FOUND OR _device.branch_id IS NULL OR _device.revoked_at IS NOT NULL
     OR _device.credential_hash IS NULL
     OR NOT public.has_branch_role(
       _actor, _tenant_id, _device.branch_id,
       ARRAY['owner', 'admin', 'manager']::public.app_role[]
     ) OR NOT EXISTS (
       SELECT 1 FROM public.branches b
       WHERE b.id = _device.branch_id
         AND b.tenant_id = _tenant_id
         AND b.status = 'active'
     ) OR NOT EXISTS (
       SELECT 1 FROM auth.users u
       WHERE u.id = _actor
         AND u.deleted_at IS NULL
         AND (u.banned_until IS NULL OR u.banned_until <= now())
     ) OR EXISTS (
       SELECT 1 FROM public.employees e
       WHERE e.user_id = _actor
         AND e.tenant_id = _tenant_id
         AND (e.branch_id IS NULL OR e.branch_id = _device.branch_id)
         AND e.status = 'inactive'
     ) THEN
    RAISE EXCEPTION 'Not authorized to approve device credential rotation'
      USING ERRCODE = '42501';
  END IF;

  -- Do not accumulate multiple live approvals for the same device.
  UPDATE public.device_credential_rotation_approvals
  SET expires_at = now()
  WHERE device_id = _device.id
    AND consumed_at IS NULL
    AND expires_at > now();

  INSERT INTO public.device_credential_rotation_approvals
    (tenant_id, branch_id, device_id, approved_by)
  VALUES (_tenant_id, _device.branch_id, _device.id, _actor)
  RETURNING id INTO _approval_id;

  INSERT INTO public.audit_logs
    (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    _tenant_id, _actor, 'device.credential_rotation_approved',
    'device_enrollment', _device.id,
    jsonb_build_object(
      'approval_id', _approval_id,
      'branch_id', _device.branch_id,
      'device_uid', _device.device_uid,
      'status', 'pending_rotation'
    )
  );

  RETURN _approval_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_device_credential_rotation(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_device_credential_rotation(uuid, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.rotate_device_credential(
  _approval_id uuid
) RETURNS TABLE(device_id uuid, device_uid text, credential text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _approval public.device_credential_rotation_approvals%ROWTYPE;
  _device public.devices%ROWTYPE;
  _credential text;
BEGIN
  IF _approval_id IS NULL THEN
    RAISE EXCEPTION 'Invalid device credential rotation request';
  END IF;

  SELECT * INTO _approval
  FROM public.device_credential_rotation_approvals
  WHERE id = _approval_id
  FOR UPDATE;

  IF NOT FOUND OR _approval.consumed_at IS NOT NULL OR _approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Device credential rotation approval is invalid, expired, or consumed'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _device
  FROM public.devices d
  WHERE d.id = _approval.device_id
    AND d.tenant_id = _approval.tenant_id
    AND d.branch_id = _approval.branch_id
  FOR UPDATE;

  IF NOT FOUND OR _device.revoked_at IS NOT NULL OR _device.credential_hash IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.branches b
       WHERE b.id = _approval.branch_id
         AND b.tenant_id = _approval.tenant_id
         AND b.status = 'active'
     ) OR NOT EXISTS (
       SELECT 1 FROM auth.users u
       WHERE u.id = _approval.approved_by
         AND u.deleted_at IS NULL
         AND (u.banned_until IS NULL OR u.banned_until <= now())
     ) OR NOT public.has_branch_role(
       _approval.approved_by,
       _approval.tenant_id,
       _approval.branch_id,
       ARRAY['owner', 'admin', 'manager']::public.app_role[]
     ) OR EXISTS (
       SELECT 1 FROM public.employees e
       WHERE e.user_id = _approval.approved_by
         AND e.tenant_id = _approval.tenant_id
         AND (e.branch_id IS NULL OR e.branch_id = _approval.branch_id)
         AND e.status = 'inactive'
     ) THEN
    RAISE EXCEPTION 'Device credential rotation authority is no longer valid'
      USING ERRCODE = '42501';
  END IF;

  _credential := encode(extensions.gen_random_bytes(32), 'hex');

  UPDATE public.devices
  SET credential_hash = extensions.digest(_credential, 'sha256'),
      credential_issued_at = now(),
      updated_at = now()
  WHERE id = _device.id;

  UPDATE public.device_credential_rotation_approvals
  SET consumed_at = now()
  WHERE id = _approval.id;

  INSERT INTO public.audit_logs
    (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    _approval.tenant_id, _approval.approved_by,
    'device.credential_rotated', 'device_enrollment', _device.id,
    jsonb_build_object(
      'approval_id', _approval.id,
      'branch_id', _approval.branch_id,
      'device_uid', _device.device_uid,
      'credential_persisted', false,
      'previous_credential_invalidated', true
    )
  );

  RETURN QUERY SELECT _device.id, _device.device_uid, _credential;
END;
$$;

REVOKE ALL ON FUNCTION public.rotate_device_credential(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_device_credential(uuid)
  TO service_role;

COMMENT ON FUNCTION public.approve_device_credential_rotation(uuid, uuid) IS
  'Manager-only branch-scoped short-lived approval for explicit enrolled-device credential rotation.';
COMMENT ON FUNCTION public.rotate_device_credential(uuid) IS
  'Privileged single-use rotation. Atomically replaces the credential verifier and returns plaintext once.';

COMMIT;
