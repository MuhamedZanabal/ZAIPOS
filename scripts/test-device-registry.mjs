import { execFileSync } from 'node:child_process';

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

const I = {
  tenantA: '11000000-0000-0000-0000-000000000081',
  tenantB: '11000000-0000-0000-0000-000000000082',
  branchA: '21000000-0000-0000-0000-000000000081',
  branchAOther: '21000000-0000-0000-0000-000000000083',
  branchB: '21000000-0000-0000-0000-000000000082',
  managerA: '31000000-0000-0000-0000-000000000081',
  managerAOther: '31000000-0000-0000-0000-000000000083',
  managerB: '31000000-0000-0000-0000-000000000082',
  cashierA: '31000000-0000-0000-0000-000000000084',
};

function psql(args, capture = true) {
  return execFileSync('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function sql(statement) { return psql(['-c', statement], false); }
function scalar(statement) {
  return psql(['-Atq', '-c', statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function asAuthenticated(userId, statement) {
  return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`);
}
function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectReject(label, userId, statement, pattern = /not authorized|permission denied|revoked/i) {
  try {
    asAuthenticated(userId, statement);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error);
    if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`);
    return;
  }
  throw new Error(`${label}: expected rejection`);
}

sql(`
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
    ('${I.managerA}','device-manager-a@zaipos.test','{}'),
    ('${I.managerAOther}','device-manager-other@zaipos.test','{}'),
    ('${I.managerB}','device-manager-b@zaipos.test','{}'),
    ('${I.cashierA}','device-cashier-a@zaipos.test','{}')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES
    ('${I.tenantA}','Device Tenant A','device-tenant-a','BHD',10,false),
    ('${I.tenantB}','Device Tenant B','device-tenant-b','BHD',10,false)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches(id,tenant_id,name,status) VALUES
    ('${I.branchA}','${I.tenantA}','Device Branch A','active'),
    ('${I.branchAOther}','${I.tenantA}','Device Branch A Other','active'),
    ('${I.branchB}','${I.tenantB}','Device Branch B','active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES
    ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),
    ('${I.managerAOther}','${I.tenantA}','${I.branchAOther}','manager'),
    ('${I.managerB}','${I.tenantB}','${I.branchB}','manager'),
    ('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier')
  ON CONFLICT DO NOTHING;
`);

for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
  assertEqual(
    `devices authenticated ${privilege}`,
    scalar(`SELECT has_table_privilege('authenticated','public.devices','${privilege}');`),
    'f',
  );
}

const heartbeatSql = (tenantId, branchId, deviceUid) => `
  SELECT (public.register_device_heartbeat(
    '${tenantId}'::uuid,
    '${branchId}'::uuid,
    '${deviceUid}',
    '1.0.0',
    'win32',
    'stable',
    'current',
    '{"printer":"usb"}'::jsonb
  )).id::text;
`;

const deviceId = asAuthenticated(I.cashierA, heartbeatSql(I.tenantA, I.branchA, 'terminal-device-a-001'));
if (!deviceId) throw new Error('authorized terminal heartbeat did not return a device ID');

expectReject('cross-tenant heartbeat', I.cashierA, heartbeatSql(I.tenantB, I.branchB, 'terminal-cross-tenant'));
expectReject('wrong-branch heartbeat', I.cashierA, heartbeatSql(I.tenantA, I.branchAOther, 'terminal-wrong-branch'));

assertEqual(
  'same-branch manager sees device',
  asAuthenticated(I.managerA, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`),
  '1',
);
assertEqual(
  'different-branch manager cannot see device',
  asAuthenticated(I.managerAOther, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`),
  '0',
);
assertEqual(
  'cashier cannot enumerate fleet',
  asAuthenticated(I.cashierA, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`),
  '0',
);

expectReject(
  'direct device mutation',
  I.cashierA,
  `UPDATE public.devices SET app_version='9.9.9' WHERE id='${deviceId}'::uuid;`,
);

sql(`UPDATE public.devices SET revoked_at=now() WHERE id='${deviceId}'::uuid;`);
expectReject('revoked device heartbeat', I.cashierA, heartbeatSql(I.tenantA, I.branchA, 'terminal-device-a-001'));

process.stdout.write('Device registry PASS: heartbeat, tenant/branch authorization, RLS visibility, revocation, and direct-mutation lockdown hold.\n');
