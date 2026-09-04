-- Forward migration for databases that already ran the inherited Colombia demo seeds.
-- Targets only the exact seeded tenant slug and exact seeded demo-account domain.

DO $$
DECLARE
  v_tenant_id uuid;
  v_branch_id uuid;
BEGIN
  SELECT id INTO v_tenant_id
  FROM public.tenants
  WHERE slug = 'panaderia'
  LIMIT 1;

  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.tenants
  SET name = 'ZAIPOS Bahrain Demo',
      slug = 'bahrain-migrated-demo',
      currency = 'BHD',
      tax_rate = 10,
      active_channels = ARRAY[
        'pos'::public.sales_channel,
        'tables'::public.sales_channel,
        'talabat'::public.sales_channel,
        'whatsapp'::public.sales_channel,
        'delivery'::public.sales_channel
      ]
  WHERE id = v_tenant_id;

  SELECT id INTO v_branch_id
  FROM public.branches
  WHERE tenant_id = v_tenant_id
  ORDER BY created_at
  LIMIT 1;

  IF v_branch_id IS NOT NULL THEN
    UPDATE public.branches
    SET name = 'Amwaj Islands Branch',
        address = 'Amwaj Islands, Muharraq, Kingdom of Bahrain',
        phone = '+97336001234'
    WHERE id = v_branch_id;

    UPDATE public.inventory_centers
    SET name = 'Main Store'
    WHERE tenant_id = v_tenant_id
      AND branch_id = v_branch_id
      AND name = 'Bodega Principal';
  END IF;

  UPDATE public.categories SET name = 'Bakery'    WHERE tenant_id = v_tenant_id AND name = 'Pan';
  UPDATE public.categories SET name = 'Pastries'  WHERE tenant_id = v_tenant_id AND name = 'Pastelería';
  UPDATE public.categories SET name = 'Cakes'     WHERE tenant_id = v_tenant_id AND name = 'Tortas';
  UPDATE public.categories SET name = 'Beverages' WHERE tenant_id = v_tenant_id AND name = 'Bebidas';

  UPDATE public.products SET name = 'White Khubz Pack',     price = 0.150, cost = 0.080, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Mogolla';
  UPDATE public.products SET name = 'Cheese Croissant',     price = 0.700, cost = 0.300, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Croissant';
  UPDATE public.products SET name = 'Vegetable Samosa',     price = 0.150, cost = 0.070, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Almojábana';
  UPDATE public.products SET name = 'Za''atar Croissant',   price = 0.650, cost = 0.270, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Pandebono';
  UPDATE public.products SET name = 'Chocolate Cake Slice', price = 1.250, cost = 0.520, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Torta de Chocolate (porción)';
  UPDATE public.products SET name = 'Karak Tea',             price = 0.200, cost = 0.075, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Tinto';
  UPDATE public.products SET name = 'Fresh Orange Juice',    price = 1.000, cost = 0.400, tax_rate = 10 WHERE tenant_id = v_tenant_id AND name = 'Jugo Natural';

  -- Remove inherited marketplace prices and recreate a Bahrain Talabat override
  -- from the current POS price. Historical sales rows remain untouched.
  DELETE FROM public.product_channel_prices
  WHERE tenant_id = v_tenant_id
    AND channel IN (
      'rappi'::public.sales_channel,
      'didi'::public.sales_channel,
      'uber'::public.sales_channel
    );

  INSERT INTO public.product_channel_prices (tenant_id, product_id, branch_id, channel, price)
  SELECT
    tenant_id,
    product_id,
    branch_id,
    'talabat'::public.sales_channel,
    round(price * 1.10, 3)
  FROM public.product_channel_prices
  WHERE tenant_id = v_tenant_id
    AND channel = 'pos'::public.sales_channel
  ON CONFLICT DO NOTHING;
END $$;

-- The inherited migration explicitly created these demo accounts with shared
-- demo passwords. Remove only that exact synthetic account domain.
DELETE FROM public.user_roles
WHERE user_id IN (
  SELECT id FROM auth.users WHERE email LIKE '%@panaderia.local'
);

DELETE FROM auth.users
WHERE email LIKE '%@panaderia.local';
