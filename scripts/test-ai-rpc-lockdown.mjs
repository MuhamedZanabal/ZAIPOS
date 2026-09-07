import { execFileSync } from 'node:child_process';

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

function scalar(statement) {
  return execFileSync('psql', [dbUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
    encoding: 'utf8',
  }).trim();
}

const functions = [
  'public.ai_search_catalog(uuid,uuid,text,integer)',
  'public.ai_quote_order(uuid,uuid,jsonb,public.sales_channel)',
  'public.ai_create_digital_order(uuid,uuid,uuid,jsonb,text,text,text,text)',
  'public.ai_handoff_to_human(uuid,text)',
];

for (const signature of functions) {
  if (scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL;`) !== 't') {
    throw new Error(`AI function missing from migrated schema: ${signature}`);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (scalar(`SELECT has_function_privilege('${role}','${signature}','EXECUTE');`) !== 'f') {
      throw new Error(`${role} can execute locked AI function ${signature}`);
    }
  }
}

process.stdout.write('AI RPC lockdown PASS: anonymous, authenticated, and service roles cannot execute legacy AI read/write tools.\n');
