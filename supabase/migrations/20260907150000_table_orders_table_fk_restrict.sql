-- Converge databases that already recorded the historical table-order FK
-- migration before its clean-install conflict was corrected.

BEGIN;

ALTER TABLE public.table_orders
  DROP CONSTRAINT IF EXISTS table_orders_table_id_fkey;

ALTER TABLE public.table_orders
  ADD CONSTRAINT table_orders_table_id_fkey
  FOREIGN KEY (table_id)
  REFERENCES public.tables(id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.table_orders
  VALIDATE CONSTRAINT table_orders_table_id_fkey;

COMMIT;
