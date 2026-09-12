-- P2 AI action approval queue.
-- This is a control-plane primitive only: approval never executes business commands.

CREATE TABLE public.ai_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (btrim(action_type) <> ''),
  payload JSONB NOT NULL,
  evidence JSONB NOT NULL,
  operation_id TEXT NOT NULL CHECK (btrim(operation_id) <> ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  review_reason TEXT,
  review_operation_id TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_action_requests_request_idempotency UNIQUE (requested_by, operation_id),
  CONSTRAINT ai_action_requests_review_idempotency UNIQUE (reviewed_by, review_operation_id),
  CONSTRAINT ai_action_requests_review_shape CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND review_reason IS NULL AND review_operation_id IS NULL AND reviewed_at IS NULL)
    OR
    (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND review_operation_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX idx_ai_action_requests_branch_status_created
  ON public.ai_action_requests (tenant_id, branch_id, status, created_at DESC);

ALTER TABLE public.ai_action_requests ENABLE ROW LEVEL SECURITY;

-- Authenticated branch members may inspect their branch queue. Direct mutation remains
-- unavailable; all writes are server-authoritative RPCs below.
CREATE POLICY ai_action_requests_branch_select
ON public.ai_action_requests
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.tenant_id = ai_action_requests.tenant_id
      AND (ur.branch_id = ai_action_requests.branch_id OR ur.branch_id IS NULL)
  )
);

REVOKE ALL ON TABLE public.ai_action_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ai_action_requests TO authenticated;

-- Defence in depth: request meaning/evidence is immutable even to privileged SQL paths.
CREATE OR REPLACE FUNCTION public.protect_ai_action_request_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'AI action request payload/evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_action_requests_immutable
BEFORE UPDATE ON public.ai_action_requests
FOR EACH ROW EXECUTE FUNCTION public.protect_ai_action_request_immutable_fields();

CREATE OR REPLACE FUNCTION public.request_ai_action_v1(
  p_branch_id UUID,
  p_action_type TEXT,
  p_payload JSONB,
  p_evidence JSONB,
  p_operation_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_tenant_id UUID;
  v_existing public.ai_action_requests%ROWTYPE;
  v_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'permission denied: authenticated user required';
  END IF;
  IF p_branch_id IS NULL OR btrim(COALESCE(p_action_type,'')) = '' OR btrim(COALESCE(p_operation_id,'')) = '' THEN
    RAISE EXCEPTION 'invalid AI action request';
  END IF;
  IF p_payload IS NULL OR p_evidence IS NULL THEN
    RAISE EXCEPTION 'payload and evidence are required';
  END IF;

  SELECT b.tenant_id INTO v_tenant_id
  FROM public.branches b
  WHERE b.id = p_branch_id AND b.status = 'active';
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'branch not found or inactive';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.tenant_id = v_tenant_id
      AND (ur.branch_id = p_branch_id OR ur.branch_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'forbidden: user is not a member of this tenant/branch';
  END IF;

  -- Serialize a caller's operation key so concurrent retries cannot race the
  -- payload-binding decision.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_operation_id, 0));

  SELECT * INTO v_existing
  FROM public.ai_action_requests
  WHERE requested_by = v_user_id AND operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing.tenant_id IS DISTINCT FROM v_tenant_id
       OR v_existing.branch_id IS DISTINCT FROM p_branch_id
       OR v_existing.action_type IS DISTINCT FROM p_action_type
       OR v_existing.payload IS DISTINCT FROM p_payload
       OR v_existing.evidence IS DISTINCT FROM p_evidence THEN
      RAISE EXCEPTION 'payload-bound idempotency violation for AI action operation';
    END IF;
    RETURN v_existing.id;
  END IF;

  INSERT INTO public.ai_action_requests (
    tenant_id, branch_id, requested_by, action_type, payload, evidence, operation_id
  ) VALUES (
    v_tenant_id, p_branch_id, v_user_id, p_action_type, p_payload, p_evidence, p_operation_id
  ) RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    v_tenant_id,
    v_user_id,
    'ai.action_requested',
    'ai_action_request',
    v_id,
    jsonb_build_object('branch_id', p_branch_id, 'action_type', p_action_type, 'operation_id', p_operation_id)
  );

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_ai_action_v1(
  p_request_id UUID,
  p_approve BOOLEAN,
  p_reason TEXT,
  p_operation_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_request public.ai_action_requests%ROWTYPE;
  v_target_status TEXT := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'permission denied: authenticated user required';
  END IF;
  IF p_request_id IS NULL OR btrim(COALESCE(p_operation_id,'')) = '' THEN
    RAISE EXCEPTION 'invalid AI action review';
  END IF;

  SELECT * INTO v_request
  FROM public.ai_action_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI action request not found';
  END IF;

  IF v_request.requested_by = v_user_id THEN
    RAISE EXCEPTION 'self review is forbidden';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = v_user_id
      AND ur.tenant_id = v_request.tenant_id
      AND (ur.branch_id = v_request.branch_id OR ur.branch_id IS NULL)
      AND ur.role IN ('owner'::public.app_role, 'admin'::public.app_role, 'manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: reviewer lacks manager authority for tenant/branch';
  END IF;

  IF v_request.status <> 'pending' THEN
    IF v_request.reviewed_by = v_user_id
       AND v_request.review_operation_id = p_operation_id
       AND v_request.status = v_target_status
       AND v_request.review_reason IS NOT DISTINCT FROM p_reason THEN
      RETURN v_request.id;
    END IF;
    RAISE EXCEPTION 'request is not pending or review payload differs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ai_action_requests ar
    WHERE ar.reviewed_by = v_user_id
      AND ar.review_operation_id = p_operation_id
      AND ar.id <> p_request_id
  ) THEN
    RAISE EXCEPTION 'review operation is already bound to another request payload';
  END IF;

  UPDATE public.ai_action_requests
  SET status = v_target_status,
      reviewed_by = v_user_id,
      review_reason = p_reason,
      review_operation_id = p_operation_id,
      reviewed_at = now()
  WHERE id = p_request_id;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity, entity_id, metadata)
  VALUES (
    v_request.tenant_id,
    v_user_id,
    CASE WHEN p_approve THEN 'ai.action_approved' ELSE 'ai.action_rejected' END,
    'ai_action_request',
    p_request_id,
    jsonb_build_object('branch_id', v_request.branch_id, 'review_operation_id', p_operation_id, 'reason', p_reason)
  );

  RETURN p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_ai_action_v1(UUID,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.review_ai_action_v1(UUID,BOOLEAN,TEXT,TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.request_ai_action_v1(UUID,TEXT,JSONB,JSONB,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_ai_action_v1(UUID,BOOLEAN,TEXT,TEXT) TO authenticated;

-- Preserve the existing no-direct-AI-mutation boundary.
REVOKE EXECUTE ON FUNCTION public.ai_quote_order(UUID,UUID,JSONB,public.sales_channel) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.ai_create_digital_order(UUID,UUID,UUID,JSONB,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated, service_role;
