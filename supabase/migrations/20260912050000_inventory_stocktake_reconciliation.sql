-- ZAIPOS P1 inventory: server-authoritative stocktake / cycle-count reconciliation.
--
-- public.inventory_stocks remains the only aggregate stock authority. Stocktake
-- records snapshot expected quantity and capture physical counts as audit evidence;
-- only commit_inventory_stocktake_v1 may post variance, and it does so through
-- public.apply_inventory_movement rather than direct stock DML. Lot-tracked stock
-- fails closed until an explicit lot-level counting workflow exists.

BEGIN;

CREATE TABLE public.inventory_stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','committed','cancelled')),
  start_operation_id uuid NOT NULL UNIQUE REFERENCES public.inventory_operations(id) ON DELETE RESTRICT,
  commit_operation_id uuid UNIQUE REFERENCES public.inventory_operations(id) ON DELETE RESTRICT,
  client_mutation_id text NOT NULL,
  started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  committed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  cancelled_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  UNIQUE (tenant_id, branch_id, client_mutation_id),
  CONSTRAINT inventory_stocktakes_terminal_fields CHECK (
    (status='open' AND committed_at IS NULL AND cancelled_at IS NULL)
    OR (status='committed' AND committed_at IS NOT NULL AND committed_by IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND committed_at IS NULL)
  )
);

CREATE UNIQUE INDEX inventory_stocktakes_one_open_center_idx
  ON public.inventory_stocktakes(inventory_center_id)
  WHERE status='open';

CREATE TABLE public.inventory_stocktake_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  stocktake_id uuid NOT NULL REFERENCES public.inventory_stocktakes(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  expected_quantity numeric(12,3) NOT NULL,
  counted_quantity numeric(12,3),
  variance_quantity numeric(12,3),
  inventory_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  counted_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  counted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stocktake_id, product_id),
  CONSTRAINT inventory_stocktake_expected_exact CHECK (expected_quantity = round(expected_quantity,3)),
  CONSTRAINT inventory_stocktake_counted_nonnegative CHECK (counted_quantity IS NULL OR (counted_quantity >= 0 AND counted_quantity = round(counted_quantity,3))),
  CONSTRAINT inventory_stocktake_variance_exact CHECK (variance_quantity IS NULL OR variance_quantity = round(variance_quantity,3)),
  CONSTRAINT inventory_stocktake_count_evidence CHECK ((counted_quantity IS NULL) = (counted_at IS NULL))
);

CREATE INDEX inventory_stocktake_lines_product_idx
  ON public.inventory_stocktake_lines(tenant_id, branch_id, inventory_center_id, product_id);

ALTER TABLE public.inventory_stocktakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_stocktake_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_stocktakes_branch_select ON public.inventory_stocktakes
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[])
);
CREATE POLICY inventory_stocktake_lines_branch_select ON public.inventory_stocktake_lines
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[])
);

REVOKE ALL ON public.inventory_stocktakes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_stocktake_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_stocktakes TO authenticated;
GRANT SELECT ON public.inventory_stocktake_lines TO authenticated;

CREATE OR REPLACE FUNCTION public.prevent_terminal_stocktake_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'Committed or cancelled stocktake evidence is immutable';
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Stocktakes cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_inventory_stocktakes_immutable
BEFORE UPDATE OR DELETE ON public.inventory_stocktakes
FOR EACH ROW EXECUTE FUNCTION public.prevent_terminal_stocktake_mutation_v1();

CREATE OR REPLACE FUNCTION public.prevent_terminal_stocktake_line_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status text;
  _stocktake_id uuid := COALESCE(NEW.stocktake_id,OLD.stocktake_id);
BEGIN
  SELECT status INTO _status FROM public.inventory_stocktakes WHERE id=_stocktake_id;
  IF _status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Committed or cancelled stocktake line evidence is immutable';
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;

CREATE TRIGGER trg_inventory_stocktake_lines_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.inventory_stocktake_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_terminal_stocktake_line_mutation_v1();

REVOKE ALL ON FUNCTION public.prevent_terminal_stocktake_mutation_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_terminal_stocktake_line_mutation_v1() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.start_inventory_stocktake_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _request jsonb;
  _claim record;
  _stocktake_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_centers
    WHERE id=_inventory_center_id AND tenant_id=_tenant_id AND branch_id=_branch_id AND status='active'
  ) THEN
    RAISE EXCEPTION 'Inventory center is invalid or inactive';
  END IF;

  -- Lot identity cannot be reconstructed from an aggregate physical count. Keep
  -- this workflow fail-closed until lot-level stocktake is explicitly implemented.
  IF EXISTS (
    SELECT 1 FROM public.product_inventory_controls
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id
      AND inventory_center_id=_inventory_center_id AND lot_tracking_enabled
  ) THEN
    RAISE EXCEPTION 'Stocktake cannot start while lot_tracking_enabled products exist; use a lot-aware reconciliation workflow';
  END IF;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,
    'inventory_center_id',_inventory_center_id
  );
  SELECT * INTO _claim FROM public.claim_inventory_operation_v2(
    _tenant_id,_branch_id,'inventory_stocktake_start',_client_mutation_id,_request
  );

  IF _claim.is_replay THEN
    SELECT id INTO _stocktake_id FROM public.inventory_stocktakes WHERE start_operation_id=_claim.operation_id;
    IF _stocktake_id IS NULL THEN RAISE EXCEPTION 'Stocktake replay evidence is missing'; END IF;
    RETURN _stocktake_id;
  END IF;

  INSERT INTO public.inventory_stocktakes(
    tenant_id,branch_id,inventory_center_id,start_operation_id,client_mutation_id,started_by
  ) VALUES(
    _tenant_id,_branch_id,_inventory_center_id,_claim.operation_id,_client_mutation_id,_user_id
  ) RETURNING id INTO _stocktake_id;

  INSERT INTO public.inventory_stocktake_lines(
    tenant_id,branch_id,inventory_center_id,stocktake_id,product_id,expected_quantity
  )
  SELECT s.tenant_id,s.branch_id,s.inventory_center_id,_stocktake_id,s.product_id,s.quantity
  FROM public.inventory_stocks s
  WHERE s.tenant_id=_tenant_id AND s.branch_id=_branch_id AND s.inventory_center_id=_inventory_center_id;

  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_claim.operation_id;
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(_tenant_id,_user_id,'inventory.stocktake_started','inventory_stocktakes',_stocktake_id,
      jsonb_build_object('branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'client_mutation_id',_client_mutation_id));
  END IF;
  RETURN _stocktake_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_inventory_stocktake_count_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _stocktake_id uuid,
  _product_id uuid,
  _counted_quantity numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake public.inventory_stocktakes%ROWTYPE;
  _line_id uuid;
  _current numeric;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _counted_quantity IS NULL OR _counted_quantity < 0 OR _counted_quantity <> round(_counted_quantity,3) THEN
    RAISE EXCEPTION 'Counted quantity must be non-negative with at most three decimal places';
  END IF;

  SELECT * INTO _stocktake FROM public.inventory_stocktakes
  WHERE id=_stocktake_id AND tenant_id=_tenant_id AND branch_id=_branch_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;
  IF _stocktake.status <> 'open' THEN RAISE EXCEPTION 'Stocktake is not open'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id=_product_id AND tenant_id=_tenant_id) THEN
    RAISE EXCEPTION 'Product is outside tenant scope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.product_inventory_controls
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id
      AND inventory_center_id=_stocktake.inventory_center_id
      AND product_id=_product_id AND lot_tracking_enabled
  ) THEN
    RAISE EXCEPTION 'lot_tracking_enabled product requires lot-level stocktake';
  END IF;

  SELECT id INTO _line_id FROM public.inventory_stocktake_lines
  WHERE stocktake_id=_stocktake_id AND product_id=_product_id FOR UPDATE;

  IF _line_id IS NULL THEN
    -- A product absent from the start snapshot is only safe to add with expected
    -- zero when no aggregate stock row appeared concurrently after the snapshot.
    SELECT quantity INTO _current FROM public.inventory_stocks
    WHERE inventory_center_id=_stocktake.inventory_center_id AND product_id=_product_id
    FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'Inventory changed after stocktake start; restart before counting this product';
    END IF;
    INSERT INTO public.inventory_stocktake_lines(
      tenant_id,branch_id,inventory_center_id,stocktake_id,product_id,expected_quantity,counted_quantity,counted_by,counted_at
    ) VALUES(
      _tenant_id,_branch_id,_stocktake.inventory_center_id,_stocktake_id,_product_id,0,_counted_quantity,_user_id,now()
    ) RETURNING id INTO _line_id;
  ELSE
    UPDATE public.inventory_stocktake_lines
    SET counted_quantity=_counted_quantity,counted_by=_user_id,counted_at=now()
    WHERE id=_line_id;
  END IF;

  RETURN _line_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_inventory_stocktake_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _stocktake_id uuid,
  _client_mutation_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _stocktake public.inventory_stocktakes%ROWTYPE;
  _request jsonb;
  _claim record;
  _line record;
  _current numeric;
  _variance numeric;
  _movement_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  SELECT * INTO _stocktake FROM public.inventory_stocktakes
  WHERE id=_stocktake_id AND tenant_id=_tenant_id AND branch_id=_branch_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocktake not found'; END IF;

  _request := jsonb_build_object(
    'tenant_id',_tenant_id,'branch_id',_branch_id,
    'inventory_center_id',_stocktake.inventory_center_id,'stocktake_id',_stocktake_id
  );
  SELECT * INTO _claim FROM public.claim_inventory_operation_v2(
    _tenant_id,_branch_id,'inventory_stocktake_commit',_client_mutation_id,_request
  );
  IF _claim.is_replay THEN RETURN _claim.operation_id; END IF;

  IF _stocktake.status <> 'open' THEN RAISE EXCEPTION 'Stocktake is not open'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inventory_stocktake_lines WHERE stocktake_id=_stocktake_id) THEN
    RAISE EXCEPTION 'Stocktake has no lines';
  END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_stocktake_lines WHERE stocktake_id=_stocktake_id AND counted_quantity IS NULL) THEN
    RAISE EXCEPTION 'Every stocktake line must be counted before commit';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.inventory_stocktake_lines l
    JOIN public.product_inventory_controls pic
      ON pic.tenant_id=l.tenant_id AND pic.branch_id=l.branch_id
     AND pic.inventory_center_id=l.inventory_center_id AND pic.product_id=l.product_id
    WHERE l.stocktake_id=_stocktake_id AND pic.lot_tracking_enabled
  ) THEN
    RAISE EXCEPTION 'lot_tracking_enabled product requires lot-level stocktake';
  END IF;

  FOR _line IN
    SELECT * FROM public.inventory_stocktake_lines WHERE stocktake_id=_stocktake_id ORDER BY product_id
  LOOP
    SELECT quantity INTO _current FROM public.inventory_stocks
    WHERE inventory_center_id=_stocktake.inventory_center_id AND product_id=_line.product_id
    FOR UPDATE;
    IF NOT FOUND THEN _current := 0; END IF;

    IF _current <> _line.expected_quantity THEN
      RAISE EXCEPTION 'Inventory changed after stocktake start for product %; expected %, current %',
        _line.product_id,_line.expected_quantity,_current;
    END IF;

    _variance := _line.counted_quantity - _current;
    _movement_id := NULL;
    IF _variance <> 0 THEN
      _movement_id := public.apply_inventory_movement(
        _tenant_id,_branch_id,_line.product_id,'adjustment'::public.movement_type,_variance,
        'Stocktake reconciliation','inventory_operation',_claim.operation_id,_user_id,_stocktake.inventory_center_id
      );
    END IF;

    UPDATE public.inventory_stocktake_lines
    SET variance_quantity=_variance,inventory_movement_id=_movement_id
    WHERE id=_line.id;
  END LOOP;

  UPDATE public.inventory_stocktakes
  SET status='committed',commit_operation_id=_claim.operation_id,committed_by=_user_id,committed_at=now()
  WHERE id=_stocktake_id;
  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_claim.operation_id;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(_tenant_id,_user_id,'inventory.stocktake_committed','inventory_stocktakes',_stocktake_id,
      jsonb_build_object('branch_id',_branch_id,'inventory_center_id',_stocktake.inventory_center_id,'operation_id',_claim.operation_id,'client_mutation_id',_client_mutation_id));
  END IF;
  RETURN _claim.operation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_inventory_stocktake_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _stocktake_id uuid,
  _reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  UPDATE public.inventory_stocktakes
  SET status='cancelled',cancelled_by=_user_id,cancelled_at=now(),cancel_reason=NULLIF(trim(COALESCE(_reason,'')),'')
  WHERE id=_stocktake_id AND tenant_id=_tenant_id AND branch_id=_branch_id AND status='open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Open stocktake not found'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.start_inventory_stocktake_v1(uuid,uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_inventory_stocktake_count_v1(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.commit_inventory_stocktake_v1(uuid,uuid,uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_inventory_stocktake_v1(uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_inventory_stocktake_v1(uuid,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_inventory_stocktake_count_v1(uuid,uuid,uuid,uuid,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_inventory_stocktake_v1(uuid,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_inventory_stocktake_v1(uuid,uuid,uuid,text) TO authenticated;

COMMENT ON TABLE public.inventory_stocktakes IS 'Auditable physical-count sessions; aggregate inventory remains authoritative until an atomic commit posts variance through inventory movements.';
COMMENT ON TABLE public.inventory_stocktake_lines IS 'Expected/count/variance evidence for a stocktake. Committed evidence is immutable.';
COMMENT ON FUNCTION public.commit_inventory_stocktake_v1(uuid,uuid,uuid,text) IS 'Row-locked, manager-authorized, idempotent stocktake commit that rejects stale snapshots and posts variance via the authoritative inventory movement boundary.';

COMMIT;
