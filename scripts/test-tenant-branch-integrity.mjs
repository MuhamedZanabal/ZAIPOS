import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";

const IDS = {
  tenantA: "10000000-0000-0000-0000-000000000091",
  tenantB: "10000000-0000-0000-0000-000000000093",
  branchA: "20000000-0000-0000-0000-000000000091",
  branchB: "20000000-0000-0000-0000-000000000093",
  ownerA: "30000000-0000-0000-0000-000000000091",
  tenantWideManager: "30000000-0000-0000-0000-000000000093",
};

function psql(args, capture = true) {
  return execFileSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function sql(statement) {
  return psql(["-c", statement], false);
}

function scalar(statement) {
  return psql(["-Atq", "-c", statement]).trim();
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectTenantBranchReject(label, statement) {
  try {
    psql(["-c", statement]);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!/violates foreign key constraint .*tenant_branch_fkey/i.test(message)) {
      throw new Error(`${label}: wrong rejection: ${message}`);
    }
    return;
  }
  throw new Error(`${label}: expected tenant/branch rejection`);
}

const missingCompositeFks = scalar(`
  WITH branch_columns AS (
    SELECT
      branch_table.oid,
      max(attribute.attnum) FILTER (WHERE attribute.attname = 'tenant_id') AS tenant_attnum,
      max(attribute.attnum) FILTER (WHERE attribute.attname = 'id') AS id_attnum
    FROM pg_class branch_table
    JOIN pg_namespace namespace ON namespace.oid = branch_table.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = branch_table.oid
    WHERE namespace.nspname = 'public'
      AND branch_table.relname = 'branches'
      AND attribute.attname IN ('tenant_id', 'id')
      AND NOT attribute.attisdropped
    GROUP BY branch_table.oid
  ), scoped_tables AS (
    SELECT
      candidate.oid,
      candidate.relname,
      max(attribute.attnum) FILTER (WHERE attribute.attname = 'tenant_id') AS tenant_attnum,
      max(attribute.attnum) FILTER (WHERE attribute.attname = 'branch_id') AS branch_attnum
    FROM pg_class candidate
    JOIN pg_namespace namespace ON namespace.oid = candidate.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = candidate.oid
    WHERE namespace.nspname = 'public'
      AND candidate.relkind IN ('r', 'p')
      AND attribute.attname IN ('tenant_id', 'branch_id')
      AND NOT attribute.attisdropped
    GROUP BY candidate.oid, candidate.relname
    HAVING count(*) FILTER (WHERE attribute.attname = 'tenant_id') = 1
       AND count(*) FILTER (WHERE attribute.attname = 'branch_id') = 1
  )
  SELECT coalesce(string_agg(scoped.relname, ',' ORDER BY scoped.relname), '')
  FROM scoped_tables scoped
  CROSS JOIN branch_columns branch
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = scoped.oid
      AND constraint_row.confrelid = branch.oid
      AND constraint_row.conkey = ARRAY[scoped.tenant_attnum, scoped.branch_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[branch.tenant_attnum, branch.id_attnum]::smallint[]
  );
`);

assertEqual("tables missing tenant/branch composite foreign keys", missingCompositeFks, "");

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES ('${IDS.tenantWideManager}','tenant-wide-manager@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode)
  VALUES ('${IDS.tenantB}','Structural Tenant B','structural-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status)
  VALUES ('${IDS.branchB}','${IDS.tenantB}','Structural Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role)
  VALUES ('${IDS.tenantWideManager}','${IDS.tenantA}',NULL,'manager')
  ON CONFLICT DO NOTHING;
`);

assertEqual(
  "tenant-wide user role remains valid",
  scalar(`SELECT count(*)::text FROM public.user_roles WHERE user_id='${IDS.tenantWideManager}'::uuid AND tenant_id='${IDS.tenantA}'::uuid AND branch_id IS NULL;`),
  "1",
);

expectTenantBranchReject(
  "branch-scoped user role",
  `UPDATE public.user_roles SET tenant_id='${IDS.tenantB}'::uuid WHERE user_id='${IDS.ownerA}'::uuid AND tenant_id='${IDS.tenantA}'::uuid;`,
);
expectTenantBranchReject(
  "cash session",
  `UPDATE public.cash_sessions SET tenant_id='${IDS.tenantB}'::uuid WHERE id='40000000-0000-0000-0000-000000000091'::uuid;`,
);
expectTenantBranchReject(
  "sale",
  `UPDATE public.sales SET tenant_id='${IDS.tenantB}'::uuid WHERE id='60000000-0000-0000-0000-000000000091'::uuid;`,
);
expectTenantBranchReject(
  "inventory stock",
  `UPDATE public.inventory_stocks SET tenant_id='${IDS.tenantB}'::uuid WHERE inventory_center_id='45000000-0000-0000-0000-000000000091'::uuid AND product_id='50000000-0000-0000-0000-000000000091'::uuid;`,
);
expectTenantBranchReject(
  "checkout operation",
  `INSERT INTO public.checkout_operations(tenant_id,branch_id,user_id,client_mutation_id,request_payload) VALUES ('${IDS.tenantB}'::uuid,'${IDS.branchA}'::uuid,'${IDS.ownerA}'::uuid,'structural-checkout-operation','{}'::jsonb);`,
);
expectTenantBranchReject(
  "inventory operation",
  `INSERT INTO public.inventory_operations(tenant_id,branch_id,operation_type,client_mutation_id,request_payload) VALUES ('${IDS.tenantB}'::uuid,'${IDS.branchA}'::uuid,'adjustment','structural-inventory-operation','{}'::jsonb);`,
);

process.stdout.write("Tenant/branch structural integrity PASS: all scoped tables reject cross-tenant branches while tenant-wide roles remain valid.\n");
