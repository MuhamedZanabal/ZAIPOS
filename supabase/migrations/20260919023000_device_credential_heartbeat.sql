-- SEC-004 Stage 3: credential possession is required for device heartbeat.
-- Legacy UID-only heartbeat is deliberately fail-closed.

CREATE OR REPLACE FUNCTION public.register_device_heartbeat(p_device_uid uuid, p_device_name text, p_branch_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'device credential required' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_device_heartbeat(p_device_uid uuid, p_device_name text, p_branch_id uuid, p_device_credential text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_user_branch_id uuid;
  v_updated integer;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501'; END IF;
  IF p_device_credential IS NULL OR length(p_device_credential) <> 64 OR p_device_credential !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid device credential' USING ERRCODE = '42501';
  END IF;

  SELECT up.tenant_id, up.branch_id INTO v_tenant_id, v_user_branch_id
  FROM public.user_profiles up WHERE up.user_id = v_user_id AND up.is_active = true;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'active operator profile required' USING ERRCODE = '42501'; END IF;
  IF v_user_branch_id IS DISTINCT FROM p_branch_id THEN RAISE EXCEPTION 'operator branch mismatch' USING ERRCODE = '42501'; END IF;

  UPDATE public.devices d
     SET last_seen_at = now(), device_name = COALESCE(NULLIF(btrim(p_device_name), ''), d.device_name)
   WHERE d.device_uid = p_device_uid
     AND d.tenant_id = v_tenant_id
     AND d.branch_id = p_branch_id
     AND d.is_active = true
     AND d.credential_hash = extensions.digest(convert_to(p_device_credential, 'UTF8'), 'sha256');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'device credential rejected' USING ERRCODE = '42501'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.register_device_heartbeat(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_heartbeat(uuid, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.register_device_heartbeat(uuid, text, uuid, text) IS
'Authenticated heartbeat requiring possession of the activated device credential; tenant and branch remain server-bound.';
