import { safeStorage } from 'electron';
import type { DeviceCredentialIdentity, DeviceCredentialStatus, DeviceOfflineLease } from './types.js';

const CREDENTIAL_KEY = 'trustedDevice.credentialCiphertext';
const IDENTITY_KEY = 'trustedDevice.identity';
const OFFLINE_LEASE_KEY = 'trustedDevice.offlineLeaseCiphertext';
const HEX_256 = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hasUnsafeControlCharacter = (value: string) => Array.from(value).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);

interface VaultStore { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void; }

function validateIdentity(identity: DeviceCredentialIdentity): DeviceCredentialIdentity {
  if (!UUID.test(identity.tenantId) || !UUID.test(identity.branchId)) throw new Error('Trusted device tenant and branch must be UUIDs');
  const deviceUid = identity.deviceUid.trim();
  if (!deviceUid || deviceUid.length > 200 || hasUnsafeControlCharacter(deviceUid)) throw new Error('Trusted device UID is invalid');
  return { tenantId: identity.tenantId, branchId: identity.branchId, deviceUid };
}
function readIdentity(value: unknown): DeviceCredentialIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.tenantId !== 'string' || typeof candidate.branchId !== 'string' || typeof candidate.deviceUid !== 'string') return null;
  try { return validateIdentity({ tenantId: candidate.tenantId, branchId: candidate.branchId, deviceUid: candidate.deviceUid }); } catch { return null; }
}
function sameIdentity(a: DeviceCredentialIdentity, b: DeviceCredentialIdentity): boolean { return a.tenantId === b.tenantId && a.branchId === b.branchId && a.deviceUid === b.deviceUid; }

export class DeviceCredentialVault {
  constructor(private readonly store: VaultStore) {}
  status(): DeviceCredentialStatus {
    const protectedByOs = safeStorage.isEncryptionAvailable(); const ciphertext = this.store.get(CREDENTIAL_KEY); const identity = readIdentity(this.store.get(IDENTITY_KEY));
    if (typeof ciphertext !== 'string' || !ciphertext || !identity) return { configured: false, protectedByOs };
    return { configured: true, protectedByOs, ...identity };
  }
  storeActivatedCredential(identityInput: DeviceCredentialIdentity, credential: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential protection is unavailable');
    if (!HEX_256.test(credential)) throw new Error('Trusted device credential must be a 256-bit hexadecimal value');
    const identity = validateIdentity(identityInput);
    this.store.set(CREDENTIAL_KEY, safeStorage.encryptString(credential).toString('base64')); this.store.set(IDENTITY_KEY, identity);
  }
  readForAuthority(identityInput: DeviceCredentialIdentity): string {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential protection is unavailable');
    const expected = validateIdentity(identityInput); const actual = readIdentity(this.store.get(IDENTITY_KEY)); const ciphertext = this.store.get(CREDENTIAL_KEY);
    if (!actual || typeof ciphertext !== 'string' || !ciphertext) throw new Error('Trusted device credential is not configured');
    if (!sameIdentity(actual, expected)) throw new Error('Trusted device identity mismatch');
    let credential: string; try { credential = safeStorage.decryptString(Buffer.from(ciphertext, 'base64')); } catch { throw new Error('Trusted device credential cannot be decrypted'); }
    if (!HEX_256.test(credential)) throw new Error('Trusted device credential is corrupt'); return credential;
  }
  storeOfflineLease(identityInput: DeviceCredentialIdentity, lease: DeviceOfflineLease): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential protection is unavailable');
    const expected = validateIdentity(identityInput); const actual = readIdentity(this.store.get(IDENTITY_KEY));
    if (!actual || !sameIdentity(actual, expected)) throw new Error('Trusted device identity mismatch');
    if (!UUID.test(lease.leaseId) || !HEX_256.test(lease.token)) throw new Error('Offline lease is invalid');
    const expiresAt = Date.parse(lease.expiresAt); const issuedAt = Date.parse(lease.issuedAt); const now = Date.now();
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || issuedAt > now + 60_000 || expiresAt <= now || expiresAt - issuedAt > 15 * 60_000) throw new Error('Offline lease lifetime is invalid');
    const payload = JSON.stringify({ ...lease, identity: expected });
    this.store.set(OFFLINE_LEASE_KEY, safeStorage.encryptString(payload).toString('base64'));
  }
  readOfflineLeaseForAuthority(identityInput: DeviceCredentialIdentity): DeviceOfflineLease {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential protection is unavailable');
    const expected = validateIdentity(identityInput); const ciphertext = this.store.get(OFFLINE_LEASE_KEY);
    if (typeof ciphertext !== 'string' || !ciphertext) throw new Error('Offline lease is not configured');
    let parsed: any; try { parsed = JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))); } catch { this.clearOfflineLease(); throw new Error('Offline lease cannot be decrypted'); }
    if (!parsed?.identity || !sameIdentity(validateIdentity(parsed.identity), expected) || !UUID.test(parsed.leaseId) || !HEX_256.test(parsed.token)) { this.clearOfflineLease(); throw new Error('Offline lease is corrupt'); }
    const expiresAt = Date.parse(parsed.expiresAt); const issuedAt = Date.parse(parsed.issuedAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(issuedAt) || expiresAt <= Date.now() || expiresAt - issuedAt > 15 * 60_000) { this.clearOfflineLease(); throw new Error('Offline lease has expired'); }
    return { leaseId: parsed.leaseId, token: parsed.token, issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt };
  }
  clearOfflineLease(): void { this.store.delete(OFFLINE_LEASE_KEY); }
  clear(): void { this.store.delete(CREDENTIAL_KEY); this.store.delete(IDENTITY_KEY); this.clearOfflineLease(); }
}
