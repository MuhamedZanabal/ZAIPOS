-- P0 SEC-004 Stage 5 hardening: a credential change invalidates every outstanding
-- offline capability for that physical device in the same database transaction.
-- This closes the rotation/re-enrollment window where an old offline lease could
-- otherwise outlive the credential verifier that authorized its issuance.
BEGIN;

CREATE OR REPLACE FUNCTION public.invalidate_device_offline_leases_on_credential_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.credential_hash IS DISTINCT FROM NEW.credential_hash THEN
    UPDATE public.device_offline_leases
    SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
        revoke_reason = CASE
          WHEN revoked_at IS NULL THEN 'device_credential_changed'
          ELSE revoke_reason
        END
    WHERE device_id = NEW.id
      AND revoked_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.invalidate_device_offline_leases_on_credential_change()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS devices_invalidate_offline_leases_on_credential_change
  ON public.devices;
CREATE TRIGGER devices_invalidate_offline_leases_on_credential_change
AFTER UPDATE OF credential_hash ON public.devices
FOR EACH ROW
WHEN (OLD.credential_hash IS DISTINCT FROM NEW.credential_hash)
EXECUTE FUNCTION public.invalidate_device_offline_leases_on_credential_change();

COMMENT ON FUNCTION public.invalidate_device_offline_leases_on_credential_change() IS
  'Fail-closed offline authority: atomically revokes outstanding device leases whenever the enrolled credential verifier changes.';

COMMIT;
