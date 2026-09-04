-- ZAIPOS local development seed — Bahrain-native demo instance.
-- Runs with `supabase db reset` after all migrations have been applied.

DO $$
DECLARE
  v_tenant_id UUID;
  v_branch_id UUID;

  v_cat_drinks UUID;
  v_cat_bakery UUID;
  v_cat_grocery UUID;
  v_cat_snacks UUID;

  v_water UUID;
  v_milk UUID;
  v_khubz UUID;
  v_samosa UUID;
  v_rice UUID;
  v_dates UUID;
  v_chips UUID;
  v_karak UUID;
BEGIN
  INSERT INTO public.tenants (
    name,
    slug,
    currency,
    tax_rate,
    domain,
    primary_color,
    theme_kind,
    active_channels
  )
  VALUES (
    'ZAIPOS Bahrain Demo',
    'bahrain-demo',
    'BHD',
    10,
    'demo.localhost',
    '#0F766E',
    'default',
    ARRAY[
      'pos'::public.sales_channel,
      'tables'::public.sales_channel,
      'talabat'::public.sales_channel,
      'whatsapp'::public.sales_channel,
      'delivery'::public.sales_channel
    ]
  )
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

  INSERT INTO public.cash_registers (tenant_id, branch_id, name)
  VALUES (v_tenant_id, v_branch_id, 'Register 1');

  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Water & Beverages', '#0284c7') RETURNING id INTO v_cat_drinks;
  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Bakery', '#b45309') RETURNING id INTO v_cat_bakery;
  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Grocery', '#ca8a04') RETURNING id INTO v_cat_grocery;
  INSERT INTO public.categories (tenant_id, name, color)
  VALUES (v_tenant_id, 'Snacks', '#dc2626') RETURNING id INTO v_cat_snacks;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_drinks, 'Drinking Water 500ml', 0.100, 0.055, 10, 'simple')
  RETURNING id INTO v_water;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_drinks, 'Fresh Milk 1L', 0.650, 0.470, 10, 'simple')
  RETURNING id INTO v_milk;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_bakery, 'White Khubz Pack', 0.150, 0.080, 10, 'simple')
  RETURNING id INTO v_khubz;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_bakery, 'Vegetable Samosa', 0.150, 0.070, 10, 'simple')
  RETURNING id INTO v_samosa;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_grocery, 'Basmati Rice 5kg', 4.950, 3.650, 10, 'simple')
  RETURNING id INTO v_rice;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_grocery, 'Dates 500g', 1.500, 1.020, 10, 'simple')
  RETURNING id INTO v_dates;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_snacks, 'Potato Chips 45g', 0.250, 0.145, 10, 'simple')
  RETURNING id INTO v_chips;

  INSERT INTO public.products (tenant_id, category_id, name, price, cost, tax_rate, product_type)
  VALUES (v_tenant_id, v_cat_drinks, 'Karak Tea', 0.200, 0.075, 10, 'simple')
  RETURNING id INTO v_karak;

  INSERT INTO public.branch_products (tenant_id, branch_id, product_id) VALUES
    (v_tenant_id, v_branch_id, v_water),
    (v_tenant_id, v_branch_id, v_milk),
    (v_tenant_id, v_branch_id, v_khubz),
    (v_tenant_id, v_branch_id, v_samosa),
    (v_tenant_id, v_branch_id, v_rice),
    (v_tenant_id, v_branch_id, v_dates),
    (v_tenant_id, v_branch_id, v_chips),
    (v_tenant_id, v_branch_id, v_karak);

  INSERT INTO public.product_channel_prices (tenant_id, product_id, channel, price) VALUES
    (v_tenant_id, v_water, 'pos', 0.100),
    (v_tenant_id, v_water, 'delivery', 0.100),
    (v_tenant_id, v_water, 'talabat', 0.120),
    (v_tenant_id, v_milk, 'pos', 0.650),
    (v_tenant_id, v_milk, 'delivery', 0.650),
    (v_tenant_id, v_milk, 'talabat', 0.700),
    (v_tenant_id, v_khubz, 'pos', 0.150),
    (v_tenant_id, v_khubz, 'delivery', 0.150),
    (v_tenant_id, v_samosa, 'pos', 0.150),
    (v_tenant_id, v_samosa, 'talabat', 0.180),
    (v_tenant_id, v_rice, 'pos', 4.950),
    (v_tenant_id, v_rice, 'delivery', 4.950),
    (v_tenant_id, v_dates, 'pos', 1.500),
    (v_tenant_id, v_dates, 'talabat', 1.650),
    (v_tenant_id, v_chips, 'pos', 0.250),
    (v_tenant_id, v_chips, 'delivery', 0.250),
    (v_tenant_id, v_karak, 'pos', 0.200),
    (v_tenant_id, v_karak, 'talabat', 0.250);
END $$;

-- Local owner account for development only.
DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_tenant_id UUID;
BEGIN
  SELECT id INTO v_tenant_id FROM public.tenants WHERE slug = 'bahrain-demo';

  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_user_meta_data,
    created_at,
    updated_at
  )
  VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    'owner@demo.local',
    crypt('Demo2026!', gen_salt('bf')),
    now(),
    '{"full_name": "Bahrain Demo Owner"}'::jsonb,
    now(),
    now()
  );

  INSERT INTO public.user_roles (user_id, tenant_id, role)
  VALUES (v_user_id, v_tenant_id, 'owner');
END $$;
