-- Stage 1 of trusted-device authority. Approval does NOT enroll, credential,
-- or authorize a terminal for any financial operation.
CREATE TABLE public.device_enrollment_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  branch_id uuid NOT NULL,
  device_uid text NOT NULL CHECK (length(btrim(device_uid)) BETWEEN 8 AND 128),
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz,
  CONSTRAINT device_enrollment_approval_branch_fk
    FOREIGN KEY (tenant_id, branch_id) REFERENCES public.branches(tenant_id, id),
  CONSTRAINT device_enrollment_approval_unique_uid UNIQUE (tenant_id, device_uid),
  CONSTRAINT device_enrollment_approval_expiry CHECK (expires_at > approved_at)
);

ALTER TABLE public.device_enrollment_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.device_enrollment_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.device_enrollment_approvals TO authenticated;
CREATE POLICY device_enrollment_approvals_manager_read
  ON public.device_enrollment_approvals FOR SELECT TO authenticated
  USING (public.has_branch_role(auth.uid(), tenant_id, branch_id,
    ARRAY['owner', 'admin', 'manager']::public.app_role[]));

CREATE OR REPLACE FUNCTION public.approve_device_enrollment(
  _tenant_id uuid, _branch_id uuid, _device_uid text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _actor uuid := auth.uid();
  _approval_id uuid;
BEGIN
  IF _actor IS NULL OR _tenant_id IS NULL OR _branch_id IS NULL
     OR _device_uid IS NULL OR length(btrim(_device_uid)) NOT BETWEEN 8 AND 128
     OR NOT public.has_branch_role(_actor, _tenant_id, _branch_id,
       ARRAY['owner', 'admin', 'manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Not authorized to approve device enrollment'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.branches b
    WHERE b.id = _branch_id AND b.tenant_id = _tenant_id AND b.status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = _actor AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= now())
  ) OR EXISTS (
    SELECT 1 FROM public.employees e WHERE e.user_id = _actor
      AND e.tenant_id = _tenant_id
      AND (e.branch_id IS NULL OR e.branch_id = _branch_id)
      AND e.status = 'inactive'
  ) THEN
    RAISE EXCEPTION 'Not authorized to approve device enrollment'
      USING ERRCODE = '42501';
  END IF;

  -- Revoked or existing device identity must use an explicit rotation flow.
  IF EXISTS (
    SELECT 1 FROM public.devices d
    WHERE d.tenant_id = _tenant_id AND d.device_uid = btrim(_device_uid)
  ) THEN
    RAISE EXCEPTION 'Device already registered; explicit rotation required'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.device_enrollment_approvals
    (tenant_id, branch_id, device_uid, approved_by)
  VALUES (_tenant_id, _branch_id, btrim(_device_uid), _actor)
  RETURNING id INTO _approval_id;

  INSERT INTO public.audit_logs
    (tenant_id, user_id, action, entity, metadata)
  VALUES
    (_tenant_id, _actor, 'device.enrollment_approved', 'device_enrollment',
     jsonb_build_object('approval_id', _approval_id, 'branch_id', _branch_id,
                        'device_uid', btrim(_device_uid),
                        'status', 'pending_credential_activation'));

  RETURN _approval_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_device_enrollment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_device_enrollment(uuid, uuid, text) TO authenticated;
COMMENT ON FUNCTION public.approve_device_enrollment(uuid, uuid, text) IS
  'Manager-only branch-scoped pending approval; does not grant device or financial authority.';
