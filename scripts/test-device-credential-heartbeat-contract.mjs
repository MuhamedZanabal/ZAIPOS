import fs from 'node:fs';
import assert from 'node:assert/strict';

const sql = fs.readFileSync('supabase/migrations/20260919023000_device_credential_heartbeat.sql', 'utf8');

assert.match(sql, /register_device_heartbeat\s*\(\s*p_device_uid\s+uuid\s*,\s*p_device_name\s+text\s*,\s*p_branch_id\s+uuid\s*,\s*p_device_credential\s+text\s*\)/i);
assert.match(sql, /length\s*\(\s*p_device_credential\s*\)\s*<>\s*64/i);
assert.match(sql, /credential_hash\s*=\s*extensions\.digest\s*\(\s*convert_to\s*\(\s*p_device_credential\s*,\s*'UTF8'\s*\)\s*,\s*'sha256'\s*\)/i);
assert.match(sql, /d\.tenant_id\s*=\s*v_tenant_id/i);
assert.match(sql, /d\.branch_id\s*=\s*p_branch_id/i);
assert.match(sql, /d\.is_active\s*=\s*true/i);
assert.match(sql, /v_user_branch_id\s+IS\s+DISTINCT\s+FROM\s+p_branch_id/i);
assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.register_device_heartbeat\s*\(\s*uuid\s*,\s*text\s*,\s*uuid\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i);
assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.register_device_heartbeat\s*\(\s*uuid\s*,\s*text\s*,\s*uuid\s*,\s*text\s*\)\s+TO\s+authenticated/i);
assert.match(sql, /RAISE\s+EXCEPTION\s+'device credential required'/i);
assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.devices/i, 'heartbeat must never self-enroll a device');

console.log('Device credential heartbeat contract: PASS');
