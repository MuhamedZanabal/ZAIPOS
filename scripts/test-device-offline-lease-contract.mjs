import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(path.resolve('supabase/migrations/20260921021000_device_offline_lease_authority.sql'), 'utf8');
const must = (pattern, message) => { if (!pattern.test(migration)) throw new Error(message); };

must(/CREATE TABLE public\.device_offline_leases/i, 'offline lease authority table missing');
must(/expires_at <= issued_at \+ interval '15 minutes'/i, 'lease must be server-bounded to 15 minutes');
must(/lease_hash bytea NOT NULL/i, 'server must retain only a lease verifier');
must(/octet_length\(lease_hash\) = 32/i, 'lease verifier must be SHA-256 sized');
must(/CREATE UNIQUE INDEX device_offline_leases_active_device_idx[\s\S]*WHERE revoked_at IS NULL/i, 'device must have at most one current lease');
must(/ALTER TABLE public\.device_offline_leases ENABLE ROW LEVEL SECURITY/i, 'lease table must have RLS enabled');
must(/REVOKE ALL ON TABLE public\.device_offline_leases FROM PUBLIC, anon, authenticated/i, 'application roles must not read lease verifier state directly');
must(/CREATE OR REPLACE FUNCTION public\.issue_device_offline_lease/i, 'lease issuance authority missing');
must(/d\.tenant_id = _tenant_id[\s\S]*d\.branch_id = _branch_id[\s\S]*d\.device_uid = btrim\(_device_uid\)[\s\S]*d\.revoked_at IS NULL[\s\S]*d\.credential_hash = extensions\.digest/i, 'issuance must bind tenant, branch, UID, active device and credential');
must(/public\.has_branch_role\(_user_id, _tenant_id, _branch_id/i, 'issuance must enforce branch role');
must(/gen_random_bytes\(32\)/i, 'lease token must be cryptographically random');
must(/digest\(convert_to\(_lease_token, 'UTF8'\), 'sha256'\)/i, 'plaintext lease token must not be persisted');
must(/revoke_reason = 'superseded'/i, 'new issuance must revoke prior active authority');
must(/CREATE OR REPLACE FUNCTION public\.revoke_device_offline_leases/i, 'explicit lease revocation authority missing');
must(/ARRAY\['owner','admin','manager'\]/i, 'lease revocation must require management authority');

console.log('device offline lease authority contract passed');
