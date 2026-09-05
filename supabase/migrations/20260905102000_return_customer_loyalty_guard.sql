-- ZAIPOS P0.6: fail closed on customer-linked returns until loyalty reversal
-- evidence is durable and exact.
--
-- checkout_sale_v2 currently mutates customers.loyalty_points but does not
-- persist the exact points award as immutable per-sale evidence. A financial
-- return must therefore not proceed for a customer-linked sale because the
-- loyalty side effect cannot yet be reversed safely and exactly.

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_customer_linked_return_without_loyalty_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _customer_id uuid;
BEGIN
  SELECT customer_id
  INTO _customer_id
  FROM public.sales
  WHERE id = NEW.original_sale_id;

  IF _customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Customer-linked return requires exact loyalty reversal evidence before it can be processed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_customer_return_loyalty_evidence ON public.sale_returns;
CREATE TRIGGER guard_customer_return_loyalty_evidence
BEFORE INSERT ON public.sale_returns
FOR EACH ROW
EXECUTE FUNCTION public.guard_customer_linked_return_without_loyalty_evidence();

COMMENT ON FUNCTION public.guard_customer_linked_return_without_loyalty_evidence() IS
  'P0.6 fail-closed guard. Blocks customer-linked returns until checkout persists exact per-sale loyalty award evidence that can be reversed atomically.';

COMMIT;
