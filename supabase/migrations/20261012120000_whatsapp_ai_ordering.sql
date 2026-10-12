-- WhatsApp AI ordering (Evolution API gateway).
--
-- wa_orders is the single source of truth for a WhatsApp order's state. Every
-- status change goes through wa_apply_transition(), which checks the allowed
-- transition table (mirrors src/modules/whatsapp-ordering/core/stateMachine.ts,
-- asserted by a unit test), bumps the row version, and writes one outbox event
-- in the same transaction. The ordering service (service_role) drains the outbox
-- to adapters (customer WhatsApp notifier, ZAIPOS POS, webhook, sheet).

CREATE TABLE public.wa_ordering_settings (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  evolution_instance text NOT NULL UNIQUE,
  shop_name text NOT NULL,
  delivery_fee_fils bigint NOT NULL DEFAULT 500 CHECK (delivery_fee_fils >= 0),
  default_eta_minutes integer NOT NULL DEFAULT 35 CHECK (default_eta_minutes BETWEEN 5 AND 240),
  orders_open boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id)
);

-- Arabic names / extra search words for the WhatsApp catalog (optional per product).
CREATE TABLE public.wa_product_aliases (
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name_ar text,
  aliases text[] NOT NULL DEFAULT '{}',
  whatsapp_enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (product_id)
);

CREATE TABLE public.wa_order_transitions (
  from_status text NOT NULL,
  to_status text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO public.wa_order_transitions(from_status, to_status) VALUES
 ('DRAFT','AWAITING_CONFIRMATION'),('DRAFT','CANCELLED'),
 ('AWAITING_CONFIRMATION','CONFIRMED'),('AWAITING_CONFIRMATION','DRAFT'),('AWAITING_CONFIRMATION','CANCELLED'),
 ('CONFIRMED','ACCEPTED'),('CONFIRMED','REJECTED'),('CONFIRMED','CANCELLED'),
 ('ACCEPTED','PREPARING'),('ACCEPTED','CANCELLED'),
 ('PREPARING','READY'),('PREPARING','CANCELLED'),
 ('READY','OUT_FOR_DELIVERY'),('READY','READY_FOR_PICKUP'),('READY','CANCELLED'),
 ('OUT_FOR_DELIVERY','DELIVERED'),('OUT_FOR_DELIVERY','FAILED_DELIVERY'),
 ('READY_FOR_PICKUP','PICKED_UP'),('READY_FOR_PICKUP','CANCELLED');

CREATE SEQUENCE public.wa_order_number_seq START 1001;

CREATE TABLE public.wa_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  chat_id text NOT NULL,
  order_number text UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','AWAITING_CONFIRMATION','CONFIRMED','ACCEPTED','PREPARING','READY',
    'OUT_FOR_DELIVERY','READY_FOR_PICKUP','DELIVERED','PICKED_UP','CANCELLED','REJECTED','FAILED_DELIVERY')),
  version integer NOT NULL DEFAULT 1,
  lines jsonb NOT NULL DEFAULT '[]',
  fulfilment text CHECK (fulfilment IN ('delivery','pickup')),
  address text,
  location jsonb,
  payment_method text CHECK (payment_method IN ('cash_on_delivery','benefitpay','card_on_delivery')),
  delivery_fee_fils bigint NOT NULL DEFAULT 0,
  quoted_total_fils bigint,
  eta_minutes integer,
  courier_name text,
  cancel_reason text,
  digital_order_id uuid,
  sale_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One active order per chat.
CREATE UNIQUE INDEX wa_orders_one_active_per_chat ON public.wa_orders(tenant_id, chat_id)
  WHERE status NOT IN ('DELIVERED','PICKED_UP','CANCELLED','REJECTED','FAILED_DELIVERY');
CREATE INDEX wa_orders_board ON public.wa_orders(tenant_id, branch_id, status, updated_at DESC);

CREATE TABLE public.wa_conversations (
  tenant_id uuid NOT NULL,
  chat_id text NOT NULL,
  customer_name text,
  lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('en','ar')),
  step text NOT NULL DEFAULT 'idle',
  active_order_id uuid REFERENCES public.wa_orders(id),
  handoff boolean NOT NULL DEFAULT false,
  handoff_reason text,
  opted_out boolean NOT NULL DEFAULT false,
  last_menu jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chat_id)
);

-- Inbound log doubles as the idempotency ledger (dedupe by WhatsApp message id).
CREATE TABLE public.wa_inbound_messages (
  message_id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  chat_id text NOT NULL,
  body text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wa_inbound_chat ON public.wa_inbound_messages(tenant_id, chat_id, received_at DESC);

-- Transactional outbox.
CREATE TABLE public.wa_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL REFERENCES public.wa_orders(id),
  event_key text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'order.status_changed',
  from_status text,
  to_status text NOT NULL,
  version integer NOT NULL,
  actor text NOT NULL CHECK (actor IN ('customer','staff','system','pos')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX wa_order_events_order ON public.wa_order_events(order_id, version);

CREATE TABLE public.wa_event_deliveries (
  event_id uuid NOT NULL REFERENCES public.wa_order_events(id),
  adapter text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, adapter)
);
CREATE INDEX wa_event_deliveries_pending ON public.wa_event_deliveries(state, next_attempt_at) WHERE state <> 'done';

CREATE TABLE public.wa_outbound_messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  chat_id text NOT NULL,
  body text NOT NULL,
  dedupe_key text UNIQUE,
  source text NOT NULL DEFAULT 'bot' CHECK (source IN ('bot','staff','notify')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  gateway_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz
);
CREATE INDEX wa_outbound_queue ON public.wa_outbound_messages(state, next_attempt_at) WHERE state = 'queued';

CREATE TABLE public.wa_gateway_status (
  evolution_instance text PRIMARY KEY,
  state text NOT NULL,
  needs_qr boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: staff read their tenant; all writes go through the functions below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wa_ordering_settings','wa_product_aliases','wa_orders','wa_conversations','wa_inbound_messages',
    'wa_order_events','wa_event_deliveries','wa_outbound_messages','wa_gateway_status','wa_order_transitions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE public.wa_order_number_seq, public.wa_outbound_messages_id_seq TO service_role;

GRANT SELECT ON public.wa_orders, public.wa_conversations, public.wa_inbound_messages, public.wa_outbound_messages,
  public.wa_ordering_settings, public.wa_product_aliases, public.wa_gateway_status TO authenticated;
GRANT SELECT ON public.wa_event_deliveries, public.wa_order_events TO authenticated;
CREATE POLICY wa_orders_staff_read ON public.wa_orders FOR SELECT TO authenticated
  USING (public.has_branch_role(auth.uid(), tenant_id, branch_id, ARRAY['owner','admin','manager','cashier','waiter','kitchen']::public.app_role[]));
CREATE POLICY wa_conversations_staff_read ON public.wa_conversations FOR SELECT TO authenticated USING (public.is_tenant_member(auth.uid(), tenant_id));
CREATE POLICY wa_inbound_staff_read ON public.wa_inbound_messages FOR SELECT TO authenticated USING (public.is_tenant_member(auth.uid(), tenant_id));
CREATE POLICY wa_outbound_staff_read ON public.wa_outbound_messages FOR SELECT TO authenticated USING (public.is_tenant_member(auth.uid(), tenant_id));
CREATE POLICY wa_settings_staff_read ON public.wa_ordering_settings FOR SELECT TO authenticated USING (public.is_tenant_member(auth.uid(), tenant_id));
CREATE POLICY wa_aliases_staff_read ON public.wa_product_aliases FOR SELECT TO authenticated USING (public.is_tenant_member(auth.uid(), tenant_id));
CREATE POLICY wa_gateway_staff_read ON public.wa_gateway_status FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wa_ordering_settings s WHERE s.evolution_instance = wa_gateway_status.evolution_instance AND public.is_tenant_member(auth.uid(), s.tenant_id)));
CREATE POLICY wa_events_manager_read ON public.wa_order_events FOR SELECT TO authenticated
  USING (public.has_branch_role(auth.uid(), tenant_id, NULL, ARRAY['owner','admin','manager']::public.app_role[]));
CREATE POLICY wa_deliveries_manager_read ON public.wa_event_deliveries FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wa_order_events e WHERE e.id = event_id
    AND public.has_branch_role(auth.uid(), e.tenant_id, NULL, ARRAY['owner','admin','manager']::public.app_role[])));
CREATE POLICY wa_service_all_settings ON public.wa_ordering_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Core transition (internal; not granted to API roles).
CREATE OR REPLACE FUNCTION public.wa_apply_transition(_order_id uuid, _to text, _expected_version integer, _actor text, _patch jsonb DEFAULT '{}')
RETURNS public.wa_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _o public.wa_orders; _from text;
BEGIN
  SELECT * INTO _o FROM public.wa_orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WhatsApp order not found'; END IF;
  IF _expected_version IS NOT NULL AND _o.version <> _expected_version THEN
    RAISE EXCEPTION 'version_conflict: order % is at v%, not v%', _o.order_number, _o.version, _expected_version USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.wa_order_transitions WHERE from_status = _o.status AND to_status = _to) THEN
    RAISE EXCEPTION 'invalid_transition: % -> %', _o.status, _to;
  END IF;
  IF _actor = 'customer' AND _to = 'CANCELLED' AND _o.status NOT IN ('DRAFT','AWAITING_CONFIRMATION','CONFIRMED','ACCEPTED') THEN
    RAISE EXCEPTION 'invalid_transition: customer cannot cancel once preparing';
  END IF;
  IF _to = 'OUT_FOR_DELIVERY' AND _o.fulfilment IS DISTINCT FROM 'delivery' THEN RAISE EXCEPTION 'invalid_transition: not a delivery order'; END IF;
  IF _to = 'READY_FOR_PICKUP' AND _o.fulfilment IS DISTINCT FROM 'pickup' THEN RAISE EXCEPTION 'invalid_transition: not a pickup order'; END IF;
  _from := _o.status;
  UPDATE public.wa_orders SET
    status = _to,
    version = version + 1,
    eta_minutes = COALESCE((_patch->>'eta_minutes')::integer, eta_minutes),
    courier_name = COALESCE(NULLIF(_patch->>'courier_name',''), courier_name),
    cancel_reason = COALESCE(NULLIF(_patch->>'cancel_reason',''), cancel_reason),
    updated_at = now()
  WHERE id = _order_id RETURNING * INTO _o;
  IF _o.order_number IS NOT NULL AND _to NOT IN ('DRAFT','AWAITING_CONFIRMATION') THEN
    INSERT INTO public.wa_order_events(tenant_id, order_id, event_key, from_status, to_status, version, actor, payload)
    VALUES (_o.tenant_id, _o.id, _o.id || ':' || _o.version, _from, _to, _o.version, _actor, to_jsonb(_o));
  END IF;
  IF _to IN ('DELIVERED','PICKED_UP','CANCELLED','REJECTED','FAILED_DELIVERY') THEN
    UPDATE public.wa_conversations SET active_order_id = NULL, step = 'idle', updated_at = now()
     WHERE tenant_id = _o.tenant_id AND chat_id = _o.chat_id AND active_order_id = _o.id;
  END IF;
  RETURN _o;
END;
$$;
REVOKE ALL ON FUNCTION public.wa_apply_transition(uuid, text, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_apply_transition(uuid, text, integer, text, jsonb) TO service_role;

-- Staff: advance / accept / reject / assign courier. Optimistic: stale version is refused.
CREATE OR REPLACE FUNCTION public.wa_staff_transition(_order_id uuid, _to text, _expected_version integer, _patch jsonb DEFAULT '{}')
RETURNS public.wa_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _o public.wa_orders;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO _o FROM public.wa_orders WHERE id = _order_id;
  IF NOT FOUND OR NOT public.has_branch_role(auth.uid(), _o.tenant_id, _o.branch_id,
     ARRAY['owner','admin','manager','cashier','waiter','kitchen','courier']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF _to IN ('DRAFT','AWAITING_CONFIRMATION','CONFIRMED') THEN RAISE EXCEPTION 'invalid_transition: customer-only step'; END IF;
  IF _expected_version IS NULL THEN RAISE EXCEPTION 'expected version required'; END IF;
  RETURN public.wa_apply_transition(_order_id, _to, _expected_version, 'staff', COALESCE(_patch, '{}'));
END;
$$;
REVOKE ALL ON FUNCTION public.wa_staff_transition(uuid, text, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_staff_transition(uuid, text, integer, jsonb) TO authenticated, service_role;

-- Staff take-over / hand back a chat, and reply as a person while the AI is paused.
CREATE OR REPLACE FUNCTION public.wa_set_handoff(_tenant_id uuid, _chat_id text, _on boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _lang text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_branch_role(auth.uid(), _tenant_id, NULL, ARRAY['owner','admin','manager','cashier']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  UPDATE public.wa_conversations SET handoff = _on, handoff_reason = CASE WHEN _on THEN 'staff_takeover' END, updated_at = now()
   WHERE tenant_id = _tenant_id AND chat_id = _chat_id RETURNING lang INTO _lang;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation not found'; END IF;
  IF NOT _on THEN
    INSERT INTO public.wa_outbound_messages(tenant_id, chat_id, body, source)
    VALUES (_tenant_id, _chat_id, CASE WHEN _lang = 'ar' THEN 'رجعت لمساعد الطلبات. اكتب *مساعدة* للخيارات.'
      ELSE 'You''re back with our ordering assistant. Reply *help* for options.' END, 'staff');
  END IF;
END; $$;
REVOKE ALL ON FUNCTION public.wa_set_handoff(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_set_handoff(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.wa_staff_reply(_tenant_id uuid, _chat_id text, _body text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_branch_role(auth.uid(), _tenant_id, NULL, ARRAY['owner','admin','manager','cashier']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF length(btrim(coalesce(_body,''))) = 0 OR length(_body) > 2000 THEN RAISE EXCEPTION 'Message must be 1-2000 characters'; END IF;
  -- Replies only into existing, non-opted-out chats that the customer started (no cold outreach).
  IF NOT EXISTS (SELECT 1 FROM public.wa_conversations WHERE tenant_id = _tenant_id AND chat_id = _chat_id AND NOT opted_out AND handoff) THEN
    RAISE EXCEPTION 'Take over the chat first (and the customer must not have opted out)';
  END IF;
  INSERT INTO public.wa_outbound_messages(tenant_id, chat_id, body, source) VALUES (_tenant_id, _chat_id, _body, 'staff') RETURNING id INTO _id;
  RETURN _id;
END; $$;
REVOKE ALL ON FUNCTION public.wa_staff_reply(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_staff_reply(uuid, text, text) TO authenticated;

-- Dead-letter admin: put a failed delivery back in the queue.
CREATE OR REPLACE FUNCTION public.wa_requeue_delivery(_event_id uuid, _adapter text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _tenant uuid;
BEGIN
  SELECT tenant_id INTO _tenant FROM public.wa_order_events WHERE id = _event_id;
  IF auth.uid() IS NULL OR _tenant IS NULL OR NOT public.has_branch_role(auth.uid(), _tenant, NULL, ARRAY['owner','admin','manager']::public.app_role[]) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  UPDATE public.wa_event_deliveries SET state = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
   WHERE event_id = _event_id AND adapter = _adapter AND state = 'dead';
END; $$;
REVOKE ALL ON FUNCTION public.wa_requeue_delivery(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_requeue_delivery(uuid, text) TO authenticated;

-- Live catalog the AI is allowed to use (real names, prices in fils, availability, stock).
CREATE OR REPLACE FUNCTION public.wa_catalog(_tenant_id uuid, _branch_id uuid)
RETURNS TABLE(product_id uuid, name_en text, name_ar text, category text, price_fils bigint, tax_rate numeric, available boolean, stock numeric, aliases text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.name, a.name_ar, COALESCE(c.name, 'Menu'),
    COALESCE(round(bp.local_price * 1000)::bigint, p.price_fils, round(p.price * 1000)::bigint),
    COALESCE(p.tax_rate, 0),
    p.status = 'active' AND COALESCE(bp.is_available, true),
    (SELECT sum(s.quantity) FROM public.inventory_stocks s WHERE s.product_id = p.id AND s.branch_id = _branch_id),
    COALESCE(a.aliases, '{}')
  FROM public.products p
  LEFT JOIN public.categories c ON c.id = p.category_id
  LEFT JOIN public.branch_products bp ON bp.product_id = p.id AND bp.branch_id = _branch_id
  LEFT JOIN public.wa_product_aliases a ON a.product_id = p.id
  WHERE p.tenant_id = _tenant_id AND COALESCE(a.whatsapp_enabled, true) AND p.status = 'active'
  ORDER BY c.sort_order NULLS LAST, c.name, p.sort_order NULLS LAST, p.name;
$$;
REVOKE ALL ON FUNCTION public.wa_catalog(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_catalog(uuid, uuid) TO service_role;

-- ZAIPOS POS adapter target: mirror the WhatsApp order into digital_orders (channel 'whatsapp'), idempotently.
CREATE TABLE public.wa_pos_sync_ledger (event_key text PRIMARY KEY, synced_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.wa_pos_sync_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_pos_sync_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wa_pos_sync_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.wa_sync_order_to_pos(_event jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key text := _event->>'key';
  _o public.wa_orders;
  _digital uuid;
  _line jsonb;
  _gross numeric := 0;
  _net numeric;
  _status text := lower(_event->>'to');
BEGIN
  IF _key IS NULL THEN RAISE EXCEPTION 'invalid event: key missing'; END IF;
  INSERT INTO public.wa_pos_sync_ledger(event_key) VALUES (_key) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF; -- replay: already applied
  SELECT * INTO _o FROM public.wa_orders WHERE id = (_event->>'orderId')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WhatsApp order not found'; END IF;
  PERFORM set_config('zaipos.wa_sync', 'on', true); -- stop the POS->WhatsApp trigger echoing our own write
  _digital := _o.digital_order_id;
  IF _digital IS NULL THEN
    INSERT INTO public.digital_orders(tenant_id, branch_id, channel, external_order_number, gross_total, platform_commission, net_total, status, notes)
    VALUES (_o.tenant_id, _o.branch_id, 'whatsapp', _o.order_number, 0, 0, 0, _status,
      concat_ws(' | ', 'WhatsApp ' || split_part(_o.chat_id, '@', 1), upper(coalesce(_o.fulfilment, '')),
        nullif(_o.address, ''), replace(coalesce(_o.payment_method, ''), '_', ' ')))
    RETURNING id INTO _digital;
    FOR _line IN SELECT * FROM jsonb_array_elements(_o.lines) LOOP
      _net := round((_line->>'unitPriceFils')::numeric * (_line->>'qty')::numeric) / 1000.0;
      INSERT INTO public.digital_order_items(tenant_id, digital_order_id, product_id, product_name, quantity, unit_price, tax_rate, discount, line_total, raw_payload, modifiers)
      VALUES (_o.tenant_id, _digital, (_line->>'productId')::uuid, _line->>'nameEn', (_line->>'qty')::numeric,
        (_line->>'unitPriceFils')::numeric / 1000.0, (_line->>'taxRatePct')::numeric, 0,
        round(_net * (1 + (_line->>'taxRatePct')::numeric / 100.0), 3), _line, COALESCE(_line->'modifiers', '[]'));
      _gross := _gross + round(_net * (1 + (_line->>'taxRatePct')::numeric / 100.0), 3);
    END LOOP;
    UPDATE public.digital_orders SET gross_total = _gross, net_total = _gross WHERE id = _digital;
    UPDATE public.wa_orders SET digital_order_id = _digital WHERE id = _o.id;
  ELSE
    UPDATE public.digital_orders SET status = CASE WHEN sale_id IS NOT NULL AND _status NOT IN ('cancelled','rejected') THEN status ELSE _status END
     WHERE id = _digital;
  END IF;
  RETURN _digital;
END; $$;
REVOKE ALL ON FUNCTION public.wa_sync_order_to_pos(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_sync_order_to_pos(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.wa_sync_health() RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.wa_sync_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_sync_health() TO service_role;

-- POS -> WhatsApp: when staff cancel or book the mirrored digital order in the POS, reflect it.
CREATE OR REPLACE FUNCTION public.wa_digital_order_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _o public.wa_orders;
BEGIN
  IF current_setting('zaipos.wa_sync', true) = 'on' OR NEW.channel <> 'whatsapp' THEN RETURN NEW; END IF;
  SELECT * INTO _o FROM public.wa_orders WHERE digital_order_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.sale_id IS DISTINCT FROM OLD.sale_id THEN
    UPDATE public.wa_orders SET sale_id = NEW.sale_id WHERE id = _o.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled'
     AND EXISTS (SELECT 1 FROM public.wa_order_transitions WHERE from_status = _o.status AND to_status = 'CANCELLED') THEN
    PERFORM public.wa_apply_transition(_o.id, 'CANCELLED', NULL, 'pos', jsonb_build_object('cancel_reason', 'cancelled at the till'));
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.wa_digital_order_changed() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_wa_digital_order_changed AFTER UPDATE ON public.digital_orders
  FOR EACH ROW EXECUTE FUNCTION public.wa_digital_order_changed();
