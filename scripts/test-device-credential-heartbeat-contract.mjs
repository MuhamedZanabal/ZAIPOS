import fs from 'node:fs';
import assert from 'node:assert/strict';

const sql = fs.readFileSync('supabase/migrations/20260919023000_device_credential_heartbeat.sql', 'utf8');

// Device identity must preserve the registry's TEXT identity type; activation
// returns the same opaque text UID and must not be narrowed to UUID.
assert.match(sql, /register_device_heartbeat\s*\(\s*p_device_uid\s+text\s*,\s*p_device_name\s+text\s*,\s*p_branch_id\s+uuid\s*,\s*p_device_credential\s+text\s*\)/i);
assert.match(sql, /length\s*\(\s*p_device_credential\s*\)\s*<>\s*64/i);
assert.match(sql, /d\.credential_hash\s*=\s*extensions\.digest\s*\(\s*convert_to\s*\(\s*p_device_credential\s*,\s*'UTF8'\s*\)\s*,\s*'sha256'\s*\)/i);
assert.match(sql, /d\.device_uid\s*=\s*btrim\s*\(\s*p_device_uid\s*\)/i);
assert.match(sql, /d\.branch_id\s*=\s*p_branch_id/i);
assert.match(sql, /d\.revoked_at\s+IS\s+NULL/i);
assert.match(sql, /public\.has_branch_role\s*\(\s*v_user_id\s*,\s*v_device\.tenant_id\s*,\s*v_device\.branch_id/i);

// Both historical credential-less surfaces must be unavailable to application
// roles. In particular, the original 8-argument registry heartbeat previously
// contained INSERT/UPSERT self-enrollment behavior.
assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.register_device_heartbeat\s*\(\s*text\s*,\s*text\s*,\s*uuid\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i);
assert.match(sql, /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.register_device_heartbeat\s*\(\s*uuid\s*,\s*uuid\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*jsonb\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i);
assert.match(sql, /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.register_device_heartbeat\s*\(\s*text\s*,\s*text\s*,\s*uuid\s*,\s*text\s*\)\s+TO\s+authenticated/i);
assert.match(sql, /RAISE\s+EXCEPTION\s+'device credential required'/i);
assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.devices/i, 'credential heartbeat migration must never self-enroll a device');

console.log('Device credential heartbeat contract: PASS');
