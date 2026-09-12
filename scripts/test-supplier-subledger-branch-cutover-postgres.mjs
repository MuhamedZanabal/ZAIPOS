import { execFileSync } from "node:child_process";

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const tenantId = "1c000000-0000-0000-0000-000000000111";
const branchId = "2c000000-0000-0000-0000-000000000111";

function scalar(statement) {
  return execFileSync("psql", [dbUrl, "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
}

scalar(`
  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode)
  VALUES('${tenantId}','Future Supplier Tenant','future-supplier-tenant','BHD',10,false)
  ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.branches(id,tenant_id,name,status)
  VALUES('${branchId}','${tenantId}','Future Supplier Branch','active')
  ON CONFLICT(id) DO NOTHING;
`);

const cutoverCount = scalar(`
  SELECT count(*)::text
  FROM public.supplier_subledger_cutovers
  WHERE tenant_id='${tenantId}'::uuid AND branch_id='${branchId}'::uuid;
`);
if (cutoverCount !== "1") {
  throw new Error(`Every branch created after supplier-subledger migration requires an automatic cutover row; got ${cutoverCount}`);
}

console.log("Future branch supplier-subledger cutover contract passed.");
