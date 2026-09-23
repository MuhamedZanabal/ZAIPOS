import { execFileSync } from 'node:child_process';

const dbUrl = process.env.POSTGRES_ADMIN_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

const I = {
  tenantA: '11000000-0000-0000-0000-000000000081', tenantB: '11000000-0000-0000-0000-000000000082',
  branchA: '21000000-0000-0000-0000-000000000081', branchAOther: '21000000-0000-0000-0000-000000000083', branchB: '21000000-0000-0000-0000-000000000082',
  managerA: '31000000-0000-0000-0000-000000000081', managerAOther: '31000000-0000-0000-0000-000000000083', managerB: '31000000-0000-0000-0000-000000000082', cashierA: '31000000-0000-0000-0000-000000000084',
};
function psql(args, capture = true) { return execFileSync('psql', [dbUrl, '-X', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' }); }
function sql(statement) { return psql(['-c', statement], false); }
function scalar(statement) { return psql(['-Atq', '-c', statement]).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function asAuthenticated(userId, statement) { return scalar(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${userId}'; ${statement}; COMMIT;`); }
function assertEqual(label, actual, expected) { if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
function expectReject(label, userId, statement, pattern = /not authorized|permission denied|revoked|credential|enroll/i) { try { asAuthenticated(userId, statement); } catch (error) { const message = String(error?.stderr ?? error?.message ?? error); if (!pattern.test(message)) throw new Error(`${label}: wrong rejection: ${message}`); return; } throw new Error(`${label}: expected rejection`); }

sql(`
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ('${I.managerA}','device-manager-a@zaipos.test','{}'),('${I.managerAOther}','device-manager-other@zaipos.test','{}'),('${I.managerB}','device-manager-b@zaipos.test','{}'),('${I.cashierA}','device-cashier-a@zaipos.test','{}') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.tenants(id,name,slug,currency,tax_rate,dev_mode) VALUES ('${I.tenantA}','Device Tenant A','device-tenant-a','BHD',10,false),('${I.tenantB}','Device Tenant B','device-tenant-b','BHD',10,false) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.branches(id,tenant_id,name,status) VALUES ('${I.branchA}','${I.tenantA}','Device Branch A','active'),('${I.branchAOther}','${I.tenantA}','Device Branch A Other','active'),('${I.branchB}','${I.tenantB}','Device Branch B','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles(user_id,tenant_id,branch_id,role) VALUES ('${I.managerA}','${I.tenantA}','${I.branchA}','manager'),('${I.managerAOther}','${I.tenantA}','${I.branchAOther}','manager'),('${I.managerB}','${I.tenantB}','${I.branchB}','manager'),('${I.cashierA}','${I.tenantA}','${I.branchA}','cashier') ON CONFLICT DO NOTHING;`);

for (const privilege of ['INSERT','UPDATE','DELETE']) assertEqual(`devices authenticated ${privilege}`, scalar(`SELECT has_table_privilege('authenticated','public.devices','${privilege}');`), 'f');

const uid = 'terminal-device-a-001';
const approval = asAuthenticated(I.managerA, `SELECT public.approve_device_enrollment('${I.tenantA}','${I.branchA}','${uid}')`);
const activated = scalar(`SET ROLE service_role; SELECT device_id::text || '|' || device_uid || '|' || credential FROM public.activate_device_enrollment('${approval}','1.0.0','win32'); RESET ROLE;`);
const [deviceId, activatedUid, credential] = activated.split('|');
assertEqual('activation preserves device UID', activatedUid, uid);
if (!/^[a-f\d]{64}$/i.test(credential)) throw new Error('activation did not return a 256-bit credential');
const heartbeatSql = (branchId, deviceUid, secret = credential) => `SELECT public.register_device_heartbeat('${deviceUid}','Device POS','${branchId}'::uuid,'${secret}');`;
// Credential-bound heartbeat intentionally returns void, never a devices composite
// containing credential_hash. Verify successful execution and persisted identity separately.
asAuthenticated(I.cashierA, heartbeatSql(I.branchA, uid));
assertEqual('credential heartbeat retains enrolled device', scalar(`SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid AND device_uid='${uid}' AND last_seen_at IS NOT NULL;`), '1');
expectReject('wrong-branch heartbeat', I.cashierA, heartbeatSql(I.branchAOther, uid));
expectReject('copied UID with wrong credential', I.cashierA, heartbeatSql(I.branchA, uid, '0'.repeat(64)));

assertEqual('same-branch manager sees device', asAuthenticated(I.managerA, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`), '1');
assertEqual('different-branch manager cannot see device', asAuthenticated(I.managerAOther, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`), '0');
assertEqual('cashier cannot enumerate fleet', asAuthenticated(I.cashierA, `SELECT count(*)::text FROM public.devices WHERE id='${deviceId}'::uuid;`), '0');
expectReject('direct device mutation', I.cashierA, `UPDATE public.devices SET app_version='9.9.9' WHERE id='${deviceId}'::uuid;`);
// revoked_at is the canonical revocation state. Device authority functions reject a
// revoked row directly; do not couple this contract to a non-existent is_active flag.
sql(`UPDATE public.devices SET revoked_at=now() WHERE id='${deviceId}'::uuid;`);
expectReject('revoked device heartbeat', I.cashierA, heartbeatSql(I.branchA, uid));

const signature='public.authorize_desktop_action(uuid,uuid,text,text,uuid)';
assertEqual('desktop authorization RPC exists',scalar(`SELECT to_regprocedure('${signature}') IS NOT NULL`),'t');
const nonce='91000000-0000-0000-0000-000000000081', hash='a'.repeat(64);
const authorize=(tenant=I.tenantA,branch=I.branchA,action='settings',digest=hash)=>`SELECT public.authorize_desktop_action('${tenant}','${branch}','${action}','${digest}','${nonce}')::text`;
expectReject('cashier cannot authorize native configuration',I.cashierA,authorize(),/forbidden|not authorized/i);
expectReject('wrong branch manager cannot authorize native configuration',I.managerAOther,authorize(),/forbidden|not authorized/i);
expectReject('cross tenant manager cannot authorize native configuration',I.managerB,authorize(),/forbidden|not authorized/i);
expectReject('unknown native action',I.managerA,authorize(I.tenantA,I.branchA,'shell'),/unsupported/i);
expectReject('invalid native payload binding',I.managerA,authorize(I.tenantA,I.branchA,'settings','bad'),/payload/i);
assertEqual('anonymous cannot execute native authorization',scalar(`SELECT has_function_privilege('anon','${signature}','EXECUTE')::text`),'false');
for(const action of ['settings','kiosk','download_update','install_update']) { const result=JSON.parse(asAuthenticated(I.managerA,authorize(I.tenantA,I.branchA,action))); assertEqual('authorization nonce binding',result.nonce,nonce); assertEqual('authorization payload binding',result.payload_sha256,hash); assertEqual('authorization action binding',result.action,action); assertEqual('authorization branch binding',result.branch_id,I.branchA); assertEqual('authorization audit exists',scalar(`SELECT count(*)::text FROM public.audit_logs WHERE id='${result.authorization_id}' AND user_id='${I.managerA}' AND action='desktop.action_authorized'`),'1'); }
sql(`UPDATE auth.users SET deleted_at=now() WHERE id='${I.managerA}';`); expectReject('deleted manager denied',I.managerA,authorize(),/not active/i);
sql(`UPDATE auth.users SET deleted_at=NULL,banned_until=now()+interval '1 day' WHERE id='${I.managerA}';`); expectReject('banned manager denied',I.managerA,authorize(),/not active/i);
sql(`UPDATE auth.users SET banned_until=NULL WHERE id='${I.managerA}'; DELETE FROM public.user_roles WHERE user_id='${I.managerA}' AND role='manager';`); expectReject('revoked manager cannot reuse desktop authority',I.managerA,authorize(),/forbidden|not authorized/i);
process.stdout.write('Device registry PASS: approved activation, credential heartbeat, tenant/branch authorization, RLS visibility, revocation, and direct-mutation lockdown hold.\n');
