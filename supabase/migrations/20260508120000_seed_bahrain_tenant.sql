-- Bahrain-native demo tenant retained at this historical migration version so
-- fresh databases never recreate the inherited Colombia demo environment.

DO $$
DECLARE
  v_tenant_id UUID;
  v_branch_id UUID;
  v_cat_bakery UUID;
  v_cat_drinks UUID;
  v_prod_khubz UUID;
  v_prod_samosa UUID;
  v_prod_karak UUID;
BEGIN
  INSERT INTO public.tenants (
    name, slug, currency, tax_rate, primary_color, theme_kind
  )
  VALUES (
    'ZAIPOS Bahrain Demo', 'bahrain-demo', 'BHD', 10, '#0F766E', 'default'
  )
  ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        currency = EXCLUDED.currency,
        tax_rate = EXCLUDED.tax_rate,
        primary_color = EXCLUDED.primary_color,
        theme_kind = EXCLUDED.theme_kind
  RETURNING id INTO v_tenant_id;

  INSERT INTO public.branches (tenant_id, name, address, phone)
  VALUES (
    v_tenant_id,
    'Amwaj Islands Branch',
    'Amwaj Islands, Muharraq, Kingdom of Bahrain',
    '+97336001234'
  )
  RETURNING id INTO v_branch_id;

  INSERT INTO public.inventory_centers (tenant_id, branch_id, name, type)
  VALUES (v_tenant_id, v_branch_id, 'Main Store', 'point_of_sale');

  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Bakery', '#b45309')
  RETURNING id INTO v_cat_bakery;

  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Beverages', '#0284c7')
  RETURNING id INTO v_cat_drinks;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_bakery, 'White Khubz Pack', 0.150, 0.080, 10, 'simple')
  RETURNING id INTO v_prod_khubz;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_bakery, 'Vegetable Samosa', 0.150, 0.070, 10, 'simple')
  RETURNING id INTO v_prod_samosa;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_drinks, 'Karak Tea', 0.200, 0.075, 10, 'simple')
  RETURNING id INTO v_prod_karak;

  INSERT INTO public.branch_products (tenant_id, branch_id, product_id) VALUES
    (v_tenant_id, v_branch_id, v_prod_khubz),
    (v_tenant_id, v_branch_id, v_prod_samosa),
    (v_tenant_id, v_branch_id, v_prod_karak);

  INSERT INTO public.product_channel_prices (tenant_id, product_id, channel, price) VALUES
    (v_tenant_id, v_prod_khubz, 'pos', 0.150),
    (v_tenant_id, v_prod_khubz, 'delivery', 0.150),
    (v_tenant_id, v_prod_samosa, 'pos', 0.150),
    (v_tenant_id, v_prod_samosa, 'delivery', 0.150),
    (v_tenant_id, v_prod_karak, 'pos', 0.200),
    (v_tenant_id, v_prod_karak, 'delivery', 0.200);
END $$;
