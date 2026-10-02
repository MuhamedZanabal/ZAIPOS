import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connection } from './postgres-recovery.mjs';

if (!process.env.POSTGRES_ADMIN_URL) throw new Error('A disposable PostgreSQL contract database is required');
const conn = connection(process.env.POSTGRES_ADMIN_URL);
const sql = (statement) => execFileSync('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement], {
  env: conn.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const tenant = 'a0000000-0000-0000-0000-000000000704';
const branchA = 'b0000000-0000-0000-0000-000000000704';
const branchB = 'b0000000-0000-0000-0000-000000000705';
const cashier = 'c0000000-0000-0000-0000-000000000704';
const uid = 'SEC004-concurrent-first-heartbeat';
const lockKey = 702704;
const appNames = ['zaipos-branch-race-a', 'zaipos-branch-race-b'];
const children = [];
let gate;

function launch(appName, branch) {
  const child = spawn('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...conn.env, PGAPPNAME: appName }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(`BEGIN;\nSET LOCAL ROLE authenticated;\nSET LOCAL request.jwt.claim.sub='${cashier}';\nSELECT (public.register_device_heartbeat('${tenant}','${branch}','${uid}','1.0.0','win32','stable','current','{}'::jsonb)).id;\nCOMMIT;\n`);
  return result;
}

async function acquireGate() {
  gate = spawn('psql', ['-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...conn.env, PGAPPNAME: 'zaipos-branch-race-gate' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(gate);
  let output = '';
  let errors = '';
  gate.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  const held = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out acquiring advisory race gate')), 10000);
    gate.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.includes('GATE_HELD')) { clearTimeout(timer); resolve(); }
    });
    gate.once('error', (error) => { clearTimeout(timer); reject(error); });
    gate.once('close', (code) => {
      if (!output.includes('GATE_HELD')) { clearTimeout(timer); reject(new Error(`Race gate exited before acquisition (${code}): ${errors}`)); }
    });
  });
  gate.stdin.write(`BEGIN;\nSELECT pg_advisory_xact_lock(${lockKey});\nSELECT 'GATE_HELD';\n`);
  await held;
}

try {
  sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${cashier}','device-branch-race@zaipos.test','{}');
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${tenant}','Device Race Contract','device-race-contract','BHD',10,false);
INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${branchA}','${tenant}','Race Branch A','active'), ('${branchB}','${tenant}','Race Branch B','active');
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${cashier}','${tenant}','${branchA}','cashier'), ('${cashier}','${tenant}','${branchB}','cashier');
CREATE FUNCTION public.zaipos_test_device_race_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$;
CREATE TRIGGER zaipos_test_device_race_gate BEFORE INSERT ON public.devices FOR EACH ROW WHEN (NEW.device_uid = '${uid}') EXECUTE FUNCTION public.zaipos_test_device_race_gate();`);
  await acquireGate();
  const requests = [launch(appNames[0], branchA), launch(appNames[1], branchB)];
  let bothBlocked = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = Number(sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name IN ('${appNames.join("','")}') AND wait_event_type='Lock' AND wait_event='advisory'`));
    if (blocked === 2) { bothBlocked = true; break; }
    await delay(100);
  }
  assert.equal(bothBlocked, true, 'Both first heartbeats must reach the insert gate before either is released');
  gate.stdin.end('COMMIT;\n');
  const results = await Promise.all(requests);
  const winners = results.filter((result) => result.code === 0);
  const losers = results.filter((result) => result.code !== 0);
  assert.equal(winners.length, 1, 'Exactly one concurrent first heartbeat must succeed');
  assert.equal(losers.length, 1, 'The conflicting branch heartbeat must fail');
  assert.match(winners[0].stdout, /[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i);
  assert.match(losers[0].stderr, /Device branch binding or revocation conflict/i);
  const persisted = sql(`SELECT branch_id::text || '|' || app_version || '|' || (revoked_at IS NULL)::text FROM public.devices WHERE tenant_id='${tenant}' AND device_uid='${uid}'`);
  assert.equal(persisted, `${results[0].code === 0 ? branchA : branchB}|1.0.0|true`, 'Only the winning branch binding may persist');
  assert.equal(sql(`SELECT count(*) FROM public.devices WHERE tenant_id='${tenant}' AND device_uid='${uid}'`), '1');
  console.log('PASS: both first registrations blocked concurrently; exactly one branch persisted; conflicting request rejected.');
} finally {
  for (const child of children) { if (child.exitCode === null) child.kill(); }
  try { sql('DROP TRIGGER IF EXISTS zaipos_test_device_race_gate ON public.devices; DROP FUNCTION IF EXISTS public.zaipos_test_device_race_gate();'); } catch { /* Preserve the original test failure. Disposable database only. */ }
}
