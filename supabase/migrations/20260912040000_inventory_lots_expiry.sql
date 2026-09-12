-- ZAIPOS P1 inventory: lot/batch/expiry foundation.
--
-- Aggregate stock in public.inventory_stocks remains the authoritative physical
-- stock total. Lot tracking is subordinate evidence attached to the existing
-- server-authoritative inventory movement transaction boundary; it is never a
-- second stock authority. Enabling lot tracking therefore requires zero legacy
-- aggregate stock so historical un-attributed quantity cannot silently become
-- sellable lot stock.

BEGIN;

CREATE TABLE public.product_inventory_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_tracking_enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  enabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_center_id, product_id)
);

CREATE TABLE public.inventory_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_number text NOT NULL,
  manufacture_date date,
  expiry_date date,
  received_quantity numeric(12,3) NOT NULL,
  quantity_remaining numeric(12,3) NOT NULL,
  is_quarantined boolean NOT NULL DEFAULT false,
  source_operation_id uuid REFERENCES public.inventory_operations(id) ON DELETE RESTRICT,
  source_inventory_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_lots_batch_number_nonempty CHECK (length(trim(batch_number)) > 0),
  CONSTRAINT inventory_lots_received_quantity_positive CHECK (received_quantity > 0 AND received_quantity = round(received_quantity,3)),
  CONSTRAINT inventory_lots_quantity_non_negative CHECK (quantity_remaining >= 0 AND quantity_remaining = round(quantity_remaining,3)),
  CONSTRAINT inventory_lots_quantity_not_above_received CHECK (quantity_remaining <= received_quantity),
  CONSTRAINT inventory_lots_expiry_date_valid CHECK (expiry_date IS NULL OR manufacture_date IS NULL OR expiry_date >= manufacture_date)
);

CREATE INDEX inventory_lots_fefo_idx
  ON public.inventory_lots(inventory_center_id, product_id, is_quarantined, expiry_date, received_at, id)
  WHERE quantity_remaining > 0;
CREATE INDEX inventory_lots_expiry_idx
  ON public.inventory_lots(tenant_id, branch_id, expiry_date)
  WHERE quantity_remaining > 0 AND expiry_date IS NOT NULL;

CREATE TABLE public.inventory_lot_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  inventory_center_id uuid NOT NULL REFERENCES public.inventory_centers(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES public.inventory_lots(id) ON DELETE RESTRICT,
  inventory_movement_id uuid REFERENCES public.inventory_movements(id) ON DELETE RESTRICT,
  inventory_operation_id uuid REFERENCES public.inventory_operations(id) ON DELETE RESTRICT,
  movement_kind text NOT NULL,
  quantity numeric(12,3) NOT NULL,
  quantity_after numeric(12,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT inventory_lot_movements_kind CHECK (movement_kind IN ('receipt','fefo_allocation','return_quarantine','manual_release')),
  CONSTRAINT inventory_lot_movements_quantity_nonzero CHECK (quantity <> 0 AND quantity = round(quantity,3)),
  CONSTRAINT inventory_lot_movements_quantity_after_non_negative CHECK (quantity_after >= 0 AND quantity_after = round(quantity_after,3))
);

ALTER TABLE public.product_inventory_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_lot_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_inventory_controls_branch_select ON public.product_inventory_controls
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[])
);
CREATE POLICY inventory_lots_branch_select ON public.inventory_lots
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','inventory','cashier']::public.app_role[])
);
CREATE POLICY inventory_lot_movements_branch_select ON public.inventory_lot_movements
FOR SELECT TO authenticated USING (
  public.has_branch_role(auth.uid(),tenant_id,branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[])
);

REVOKE ALL ON public.product_inventory_controls FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_lots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inventory_lot_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_inventory_controls TO authenticated;
GRANT SELECT ON public.inventory_lots TO authenticated;
GRANT SELECT ON public.inventory_lot_movements TO authenticated;

CREATE OR REPLACE FUNCTION public.configure_product_lot_tracking_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _product_id uuid,
  _enabled boolean,
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
  _operation_id uuid;
  _stock numeric := 0;
  _lot_quantity numeric := 0;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inventory_centers WHERE id=_inventory_center_id AND tenant_id=_tenant_id AND branch_id=_branch_id AND status='active') THEN
    RAISE EXCEPTION 'Inventory center is invalid or inactive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id=_product_id AND tenant_id=_tenant_id AND status='active') THEN
    RAISE EXCEPTION 'Inventory product is invalid or inactive';
  END IF;

  _request := jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'product_id',_product_id,'enabled',_enabled);
  SELECT * INTO _claim FROM public.claim_inventory_operation_v2(_tenant_id,_branch_id,'configure_lot_tracking',_client_mutation_id,_request);
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  SELECT COALESCE(quantity,0) INTO _stock FROM public.inventory_stocks
  WHERE inventory_center_id=_inventory_center_id AND product_id=_product_id FOR UPDATE;
  SELECT COALESCE(sum(quantity_remaining),0) INTO _lot_quantity FROM public.inventory_lots
  WHERE inventory_center_id=_inventory_center_id AND product_id=_product_id;

  IF _enabled AND (_stock <> 0 OR _lot_quantity <> 0) THEN
    RAISE EXCEPTION 'Lot tracking can only be enabled at zero aggregate stock; reconcile legacy stock first';
  END IF;
  IF NOT _enabled AND _lot_quantity <> 0 THEN
    RAISE EXCEPTION 'Lot tracking cannot be disabled while lot quantity remains';
  END IF;

  INSERT INTO public.product_inventory_controls(tenant_id,branch_id,inventory_center_id,product_id,lot_tracking_enabled,enabled_at,enabled_by)
  VALUES(_tenant_id,_branch_id,_inventory_center_id,_product_id,_enabled,CASE WHEN _enabled THEN now() ELSE NULL END,CASE WHEN _enabled THEN _user_id ELSE NULL END)
  ON CONFLICT(inventory_center_id,product_id) DO UPDATE
  SET lot_tracking_enabled=EXCLUDED.lot_tracking_enabled,
      enabled_at=CASE WHEN EXCLUDED.lot_tracking_enabled THEN COALESCE(product_inventory_controls.enabled_at,now()) ELSE NULL END,
      enabled_by=CASE WHEN EXCLUDED.lot_tracking_enabled THEN _user_id ELSE NULL END,
      updated_at=now();

  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(_tenant_id,_user_id,'inventory.lot_tracking_configured','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'product_id',_product_id,'enabled',_enabled,'client_mutation_id',_client_mutation_id));
  END IF;
  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_product_lot_tracking_v1(uuid,uuid,uuid,uuid,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.configure_product_lot_tracking_v1(uuid,uuid,uuid,uuid,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.allocate_inventory_lots_fefo_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _product_id uuid,
  _quantity numeric,
  _inventory_movement_id uuid,
  _inventory_operation_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _remaining numeric := _quantity;
  _lot record;
  _take numeric;
BEGIN
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3) THEN
    RAISE EXCEPTION 'FEFO quantity must be positive with at most three decimal places';
  END IF;
  FOR _lot IN
    SELECT id,quantity_remaining
    FROM public.inventory_lots
    WHERE tenant_id=_tenant_id AND branch_id=_branch_id
      AND inventory_center_id=_inventory_center_id AND product_id=_product_id
      AND quantity_remaining > 0 AND is_quarantined=false
      AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
    ORDER BY expiry_date ASC NULLS LAST, received_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN _remaining <= 0;
    _take := LEAST(_remaining,_lot.quantity_remaining);
    UPDATE public.inventory_lots SET quantity_remaining=quantity_remaining-_take WHERE id=_lot.id;
    INSERT INTO public.inventory_lot_movements(
      tenant_id,branch_id,inventory_center_id,product_id,lot_id,inventory_movement_id,inventory_operation_id,movement_kind,quantity,quantity_after,created_by
    ) VALUES(
      _tenant_id,_branch_id,_inventory_center_id,_product_id,_lot.id,_inventory_movement_id,_inventory_operation_id,'fefo_allocation',-_take,_lot.quantity_remaining-_take,auth.uid()
    );
    _remaining := _remaining-_take;
  END LOOP;
  IF _remaining > 0 THEN
    RAISE EXCEPTION 'Insufficient unexpired non-quarantined lot stock for FEFO allocation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_inventory_lots_fefo_v1(uuid,uuid,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.receive_inventory_lot_v1(
  _tenant_id uuid,
  _branch_id uuid,
  _inventory_center_id uuid,
  _product_id uuid,
  _batch_number text,
  _manufacture_date date,
  _expiry_date date,
  _quantity numeric,
  _client_mutation_id text,
  _reason text DEFAULT NULL
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
  _operation_id uuid;
  _lot_id uuid;
  _movement_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_branch_role(_user_id,_tenant_id,_branch_id,ARRAY['owner','admin','manager','inventory']::public.app_role[]) THEN RAISE EXCEPTION 'Forbidden'; END IF;
  _batch_number := NULLIF(trim(COALESCE(_batch_number,'')),'');
  IF _batch_number IS NULL THEN RAISE EXCEPTION 'Batch number is required'; END IF;
  IF _quantity IS NULL OR _quantity <= 0 OR _quantity <> round(_quantity,3) THEN RAISE EXCEPTION 'Lot receipt quantity must be positive with at most three decimal places'; END IF;
  IF _expiry_date IS NOT NULL AND _manufacture_date IS NOT NULL AND _expiry_date < _manufacture_date THEN RAISE EXCEPTION 'Expiry date cannot precede manufacture date'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_inventory_controls WHERE tenant_id=_tenant_id AND branch_id=_branch_id AND inventory_center_id=_inventory_center_id AND product_id=_product_id AND lot_tracking_enabled) THEN
    RAISE EXCEPTION 'Lot tracking is not enabled for this product and inventory center';
  END IF;

  _request := jsonb_build_object('tenant_id',_tenant_id,'branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'product_id',_product_id,'batch_number',_batch_number,'manufacture_date',_manufacture_date,'expiry_date',_expiry_date,'quantity',_quantity,'reason',NULLIF(trim(COALESCE(_reason,'')),''));
  SELECT * INTO _claim FROM public.claim_inventory_operation_v2(_tenant_id,_branch_id,'inventory_lot_receipt',_client_mutation_id,_request);
  _operation_id := _claim.operation_id;
  IF _claim.is_replay THEN RETURN _operation_id; END IF;

  INSERT INTO public.inventory_lots(tenant_id,branch_id,inventory_center_id,product_id,batch_number,manufacture_date,expiry_date,received_quantity,quantity_remaining,source_operation_id,created_by)
  VALUES(_tenant_id,_branch_id,_inventory_center_id,_product_id,_batch_number,_manufacture_date,_expiry_date,_quantity,_quantity,_operation_id,_user_id)
  RETURNING id INTO _lot_id;

  _movement_id := public.apply_inventory_movement(_tenant_id,_branch_id,_product_id,'purchase'::public.movement_type,_quantity,
    COALESCE(NULLIF(trim(COALESCE(_reason,'')),''),'Lot receipt'),'inventory_lot_operation',_operation_id,_user_id,_inventory_center_id);

  UPDATE public.inventory_lots SET source_inventory_movement_id=_movement_id WHERE id=_lot_id;
  INSERT INTO public.inventory_lot_movements(tenant_id,branch_id,inventory_center_id,product_id,lot_id,inventory_movement_id,inventory_operation_id,movement_kind,quantity,quantity_after,created_by)
  VALUES(_tenant_id,_branch_id,_inventory_center_id,_product_id,_lot_id,_movement_id,_operation_id,'receipt',_quantity,_quantity,_user_id);

  UPDATE public.inventory_operations SET status='completed',completed_at=now() WHERE id=_operation_id;
  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(_tenant_id,_user_id,'inventory.lot_received','inventory_operations',_operation_id,
      jsonb_build_object('branch_id',_branch_id,'inventory_center_id',_inventory_center_id,'product_id',_product_id,'lot_id',_lot_id,'batch_number',_batch_number,'expiry_date',_expiry_date,'quantity',_quantity,'client_mutation_id',_client_mutation_id));
  END IF;
  RETURN _operation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.receive_inventory_lot_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_inventory_lot_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_inventory_lot_movement_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tracked boolean;
  _lot_id uuid;
BEGIN
  SELECT COALESCE(lot_tracking_enabled,false) INTO _tracked
  FROM public.product_inventory_controls
  WHERE tenant_id=NEW.tenant_id AND branch_id=NEW.branch_id
    AND inventory_center_id=NEW.inventory_center_id AND product_id=NEW.product_id;
  IF NOT COALESCE(_tracked,false) THEN RETURN NEW; END IF;

  IF NEW.movement_type IN ('sale','waste','consumption','transfer') THEN
    PERFORM public.allocate_inventory_lots_fefo_v1(
      NEW.tenant_id,NEW.branch_id,NEW.inventory_center_id,NEW.product_id,abs(NEW.quantity),NEW.id,
      CASE WHEN NEW.reference_type IN ('inventory_operation','inventory_lot_operation') THEN NEW.reference_id ELSE NULL END
    );
    RETURN NEW;
  END IF;

  IF NEW.movement_type='adjustment' AND NEW.quantity < 0 THEN
    PERFORM public.allocate_inventory_lots_fefo_v1(
      NEW.tenant_id,NEW.branch_id,NEW.inventory_center_id,NEW.product_id,abs(NEW.quantity),NEW.id,
      CASE WHEN NEW.reference_type IN ('inventory_operation','inventory_lot_operation') THEN NEW.reference_id ELSE NULL END
    );
    RETURN NEW;
  END IF;

  IF NEW.movement_type='return' THEN
    INSERT INTO public.inventory_lots(tenant_id,branch_id,inventory_center_id,product_id,batch_number,received_quantity,quantity_remaining,is_quarantined,source_inventory_movement_id,created_by)
    VALUES(NEW.tenant_id,NEW.branch_id,NEW.inventory_center_id,NEW.product_id,'RETURN-' || left(NEW.id::text,8),abs(NEW.quantity),abs(NEW.quantity),true,NEW.id,NEW.user_id)
    RETURNING id INTO _lot_id;
    INSERT INTO public.inventory_lot_movements(tenant_id,branch_id,inventory_center_id,product_id,lot_id,inventory_movement_id,movement_kind,quantity,quantity_after,created_by)
    VALUES(NEW.tenant_id,NEW.branch_id,NEW.inventory_center_id,NEW.product_id,_lot_id,NEW.id,'return_quarantine',abs(NEW.quantity),abs(NEW.quantity),NEW.user_id);
    RETURN NEW;
  END IF;

  IF NEW.reference_type='inventory_lot_operation' AND NEW.movement_type='purchase' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Lot-controlled inventory requires a lot-aware inbound or transfer command';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_inventory_lot_movement_v1 ON public.inventory_movements;
CREATE TRIGGER trg_enforce_inventory_lot_movement_v1
AFTER INSERT ON public.inventory_movements
FOR EACH ROW EXECUTE FUNCTION public.enforce_inventory_lot_movement_v1();

REVOKE ALL ON FUNCTION public.enforce_inventory_lot_movement_v1() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.inventory_lots IS 'Batch/expiry evidence subordinate to authoritative aggregate stock; quantity is mutated only through server inventory commands.';
COMMENT ON FUNCTION public.allocate_inventory_lots_fefo_v1(uuid,uuid,uuid,uuid,numeric,uuid,uuid) IS 'Internal row-locked FEFO allocator for lot-controlled aggregate stock outflows.';
COMMENT ON FUNCTION public.receive_inventory_lot_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,text,text) IS 'Server-authoritative idempotent lot receipt that commits aggregate stock and lot evidence in one transaction.';

COMMIT;
