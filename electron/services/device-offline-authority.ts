import { safeStorage } from 'electron';
import type { DeviceAuthorization, DeviceOfflineLease } from '../types.js';

type CredentialRecord = { deviceUid: string; tenantId?: string; branchId?: string; encryptedCredential?: string };
type CredentialStore = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void };
const ENROLLMENT_KEY = 'enrollment';
const LEASE_KEY = 'offline-lease';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_256 = /^[0-9a-f]{64}$/i;

function requiredString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function requiredUuid(value: unknown, label: string): string {
  const valueString = requiredString(value, label, 128);
  if (!UUID.test(valueString)) throw new Error(`Invalid ${label}`);
  return valueString;
}
function rpcUrl(baseUrl: string, functionName: string): string {
  const parsed = new URL(requiredString(baseUrl, 'Supabase URL', 2048));
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Supabase URL must use HTTPS');
  parsed.pathname = `/rest/v1/rpc/${functionName}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

export function createDeviceOfflineAuthority(store: CredentialStore, baseUrl: string, publishableKey: string) {
  const clear = (): void => { if (store.delete) store.delete(LEASE_KEY); else store.set(LEASE_KEY, undefined); };
  const readEnrollment = (authorization: DeviceAuthorization): { deviceUid: string; credential: string } => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable');
    const tenantId = requiredUuid(authorization?.tenantId, 'tenant ID');
    const branchId = requiredUuid(authorization?.branchId, 'branch ID');
    const raw = store.get(ENROLLMENT_KEY);
    if (!raw || typeof raw !== 'object') throw new Error('This terminal is not provisioned');
    const record = raw as CredentialRecord;
    if (record.tenantId !== tenantId || record.branchId !== branchId || !record.encryptedCredential) throw new Error('Stored device credential scope does not match authorization scope');
    const deviceUid = requiredString(record.deviceUid, 'device UID', 128);
    let credential: string;
    try { credential = safeStorage.decryptString(Buffer.from(record.encryptedCredential, 'base64')); }
    catch { throw new Error('Stored device credential cannot be decrypted'); }
    if (!HEX_256.test(credential)) throw new Error('Stored device credential is invalid');
    return { deviceUid, credential };
  };
  return {
    clear,
    async refresh(authorization: DeviceAuthorization): Promise<{ leaseId: string; issuedAt: string; expiresAt: string }> {
      const accessToken = requiredString(authorization?.accessToken, 'access token', 16384);
      const tenantId = requiredUuid(authorization?.tenantId, 'tenant ID');
      const branchId = requiredUuid(authorization?.branchId, 'branch ID');
      const { deviceUid, credential } = readEnrollment(authorization);
      const response = await fetch(rpcUrl(baseUrl, 'issue_device_offline_lease'), {
        method: 'POST',
        headers: { apikey: requiredString(publishableKey, 'Supabase publishable key', 8192), authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ _tenant_id: tenantId, _branch_id: branchId, _device_uid: deviceUid, _device_credential: credential }),
      });
      const text = await response.text();
      if (!response.ok) { clear(); throw new Error(`Offline authority request failed (${response.status})`); }
      const decoded = text ? JSON.parse(text) : null;
      const row = Array.isArray(decoded) ? decoded[0] : decoded;
      if (!row || typeof row !== 'object') { clear(); throw new Error('Offline authority returned an invalid lease'); }
      const leaseId = requiredUuid((row as Record<string, unknown>).lease_id, 'offline lease ID');
      const token = requiredString((row as Record<string, unknown>).lease_token, 'offline lease token', 128);
      if (!HEX_256.test(token)) { clear(); throw new Error('Offline authority returned an invalid token'); }
      const expiresAt = requiredString((row as Record<string, unknown>).expires_at, 'offline lease expiry', 128);
      const expiresMs = Date.parse(expiresAt);
      const issuedAt = new Date().toISOString();
      const now = Date.now();
      if (!Number.isFinite(expiresMs) || expiresMs <= now || expiresMs - now > 15 * 60_000 + 60_000) { clear(); throw new Error('Offline authority returned an invalid lifetime'); }
      const lease: DeviceOfflineLease = { leaseId, token, issuedAt, expiresAt };
      const protectedPayload = JSON.stringify({ tenantId, branchId, deviceUid, lease });
      store.set(LEASE_KEY, safeStorage.encryptString(protectedPayload).toString('base64'));
      return { leaseId, issuedAt, expiresAt };
    },
  };
}
