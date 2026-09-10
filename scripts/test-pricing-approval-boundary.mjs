import { execFileSync } from 'node:child_process';

const db = process.env.POSTGRES_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const result = execFileSync('psql', [db, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c',
  "SELECT has_function_privilege('authenticated', 'public.apply_product_pricing_policy_v1(uuid,uuid,uuid,public.sales_channel,bigint,text,text)', 'EXECUTE');"
], { encoding: 'utf8' }).trim();
if (result !== 'f') throw new Error('Approval bypass: cost-only apply is executable without the reviewed price/policy snapshot');
process.stdout.write('Cost-only pricing apply is private; reviewed batch approval is required.\n');
