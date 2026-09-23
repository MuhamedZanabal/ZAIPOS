import { safeStorage } from 'electron';
import type { DeviceAuthorization, DeviceOfflineLease } from '../types.js';

type CredentialRecord = { deviceUid: string; tenantId?: string; branchId?: string; encryptedCredential?: string };
type CredentialStore = { get(key: string): unknown; set(key: string, value: unknown): void; delete?(key: string): void };
type ProtectedLeaseRecord = { tenantId: string; branchId: string; deviceUid: string; lease: DeviceOfflineLease };
const ENROLLMENT_KEY = 'enrollment';
const LEASE_KEY = 'offline-lease';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_256 = /^[0-9a-f]{64}$/i;
const MAX_LEASE_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;

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
  const readActive = (authorization: DeviceAuthorization): DeviceOfflineLease => {
    const tenantId = requiredUuid(authorization?.tenantId, 'tenant ID');
    const branchId = requiredUuid(authorization?.branchId, 'branch ID');
    if (!safeStorage.isEncryptionAvailable()) { clear(); throw new Error('Operating-system credential encryption is unavailable'); }
    const enrollment = store.get(ENROLLMENT_KEY) as Partial<CredentialRecord> | undefined;
    const encrypted = store.get(LEASE_KEY);
    if (!enrollment || typeof enrollment !== 'object' || typeof encrypted !== 'string' || !encrypted) throw new Error('No offline authority is available');
    let parsed: ProtectedLeaseRecord;
    try { parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as ProtectedLeaseRecord; }
    catch { clear(); throw new Error('Protected offline authority cannot be decrypted'); }
    try {
      const deviceUid = requiredString(parsed?.deviceUid, 'offline lease device UID', 128);
      if (parsed?.tenantId !== tenantId || parsed?.branchId !== branchId || deviceUid !== enrollment.deviceUid || enrollment.tenantId !== tenantId || enrollment.branchId !== branchId) throw new Error('Offline authority scope does not match this terminal');
      const leaseId = requiredUuid(parsed?.lease?.leaseId, 'offline lease ID');
      const token = requiredString(parsed?.lease?.token, 'offline lease token', 128);
      if (!HEX_256.test(token)) throw new Error('Offline authority token is invalid');
      const issuedMs = Date.parse(requiredString(parsed?.lease?.issuedAt, 'offline lease issue time', 128));
      const expiresMs = Date.parse(requiredString(parsed?.lease?.expiresAt, 'offline lease expiry', 128));
      const now = Date.now();
      if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= now || issuedMs > now + CLOCK_SKEW_MS || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_LEASE_MS + CLOCK_SKEW_MS) throw new Error('Offline authority is expired or has an invalid lifetime');
      return { leaseId, token, issuedAt: parsed.lease.issuedAt, expiresAt: parsed.lease.expiresAt };
    } catch (error) { clear(); throw error; }
  };
  return {
    clear,
    readActive,
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
      if (!Number.isFinite(expiresMs) || expiresMs <= now || expiresMs - now > MAX_LEASE_MS + CLOCK_SKEW_MS) { clear(); throw new Error('Offline authority returned an invalid lifetime'); }
      const lease: DeviceOfflineLease = { leaseId, token, issuedAt, expiresAt };
      const protectedPayload = JSON.stringify({ tenantId, branchId, deviceUid, lease });
      store.set(LEASE_KEY, safeStorage.encryptString(protectedPayload).toString('base64'));
      return { leaseId, issuedAt, expiresAt };
    },
  };
}
