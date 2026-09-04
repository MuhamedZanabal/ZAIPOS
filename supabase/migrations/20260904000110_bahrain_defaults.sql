-- Bahrain-native tenant defaults and bootstrap behavior.
-- Depends on 20260904000100_add_talabat_channel.sql.

ALTER TABLE public.tenants
  ALTER COLUMN currency SET DEFAULT 'BHD',
  ALTER COLUMN tax_rate SET DEFAULT 10,
  ALTER COLUMN active_channels SET DEFAULT ARRAY[
    'pos'::public.sales_channel,
    'tables'::public.sales_channel,
    'talabat'::public.sales_channel,
    'whatsapp'::public.sales_channel,
    'delivery'::public.sales_channel
  ];

-- Hard-cut inherited country defaults for existing tenants.
UPDATE public.tenants
SET currency = 'BHD'
WHERE currency IS DISTINCT FROM 'BHD';

UPDATE public.tenants
SET tax_rate = 10
WHERE tax_rate IS NULL OR tax_rate = 19;

-- Runtime Bahrain channels become authoritative. Historical enum values remain only
-- for compatibility with already-recorded rows and old migrations.
UPDATE public.tenants
SET active_channels = ARRAY[
  'pos'::public.sales_channel,
  'tables'::public.sales_channel,
  'talabat'::public.sales_channel,
  'whatsapp'::public.sales_channel,
  'delivery'::public.sales_channel
];

CREATE OR REPLACE FUNCTION public.bootstrap_first_tenant(
  _name text,
  _branch_name text DEFAULT 'Main Branch',
  _tax_rate numeric DEFAULT 10,
  _slug text DEFAULT NULL
)
RETURNS TABLE(tenant_id uuid, branch_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _tenant_id uuid;
  _branch_id uuid;
  _slug_value text;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants LIMIT 1) THEN
    RAISE EXCEPTION 'Bootstrap is closed: the first business already exists';
  END IF;

  IF length(trim(COALESCE(_name, ''))) = 0 THEN
    RAISE EXCEPTION 'Business name is required';
  END IF;

  _slug_value := COALESCE(
    NULLIF(trim(_slug), ''),
    trim(both '-' from regexp_replace(lower(_name), '[^a-z0-9]+', '-', 'g'))
  );

  INSERT INTO public.tenants (
    name,
    slug,
    currency,
    tax_rate,
    active_channels
  )
  VALUES (
    trim(_name),
    NULLIF(_slug_value, ''),
    'BHD',
    COALESCE(_tax_rate, 10),
    ARRAY[
      'pos'::public.sales_channel,
      'tables'::public.sales_channel,
      'talabat'::public.sales_channel,
      'whatsapp'::public.sales_channel,
      'delivery'::public.sales_channel
    ]
  )
  RETURNING id INTO _tenant_id;

  INSERT INTO public.branches (tenant_id, name)
  VALUES (_tenant_id, COALESCE(NULLIF(trim(_branch_name), ''), 'Main Branch'))
  RETURNING id INTO _branch_id;

  INSERT INTO public.user_roles (tenant_id, user_id, role, branch_id)
  VALUES (_tenant_id, _user_id, 'owner'::public.app_role, NULL);

  INSERT INTO public.cash_registers (tenant_id, branch_id, name)
  VALUES (_tenant_id, _branch_id, 'Register 1');

  UPDATE public.profiles
  SET default_tenant_id = _tenant_id,
      default_branch_id = _branch_id,
      updated_at = now()
  WHERE id = _user_id;

  tenant_id := _tenant_id;
  branch_id := _branch_id;
  RETURN NEXT;
END;
$$;
