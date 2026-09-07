-- Add missing FK from table_orders.table_id to tables.id
-- PostgREST requires this to resolve .select("*, tables(...)") joins
-- An earlier compatibility migration may already have created this constraint
-- with transitional CASCADE semantics. Replace it deterministically so clean
-- installs and upgraded databases converge on the intended RESTRICT behavior.
ALTER TABLE public.table_orders
  DROP CONSTRAINT IF EXISTS table_orders_table_id_fkey;

ALTER TABLE public.table_orders
  ADD CONSTRAINT table_orders_table_id_fkey
  FOREIGN KEY (table_id) REFERENCES public.tables(id) ON DELETE RESTRICT;
