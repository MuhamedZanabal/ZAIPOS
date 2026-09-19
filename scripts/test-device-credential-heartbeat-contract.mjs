import fs from 'node:fs';
import assert from 'node:assert/strict';

const sql = fs.readFileSync('supabase/migrations/20260919023000_device_credential_heartbeat.sql', 'utf8');

assert.match(sql, /register_device_heartbeat\(p_device_uid uuid, p_device_name text, p_branch_id uuid, p_device_credential text\)/i);
assert.match(sql, /length\(p_device_credential\) <> 64/i);
assert.match(sql, /credential_hash = extensions\.digest\(convert_to\(p_device_credential, 'UTF8'\), 'sha256'\)/i);
assert.match(sql, /d\.tenant_id = v_tenant_id/i);
assert.match(sql, /d\.branch_id = p_branch_id/i);
assert.match(sql, /d\.is_active = true/i);
assert.match(sql, /v_user_branch_id IS DISTINCT FROM p_branch_id/i);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.register_device_heartbeat\(uuid, text, uuid\) FROM PUBLIC, anon, authenticated/i);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.register_device_heartbeat\(uuid, text, uuid, text\) TO authenticated/i);
assert.match(sql, /RAISE EXCEPTION 'device credential required'/i);
assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.devices/i, 'heartbeat must never self-enroll a device');

console.log('Device credential heartbeat contract: PASS');
