import { safeStorage } from 'electron';
import type { DeviceCredentialIdentity, DeviceCredentialStatus } from './types.js';

const CREDENTIAL_KEY = 'trustedDevice.credentialCiphertext';
const IDENTITY_KEY = 'trustedDevice.identity';
const HEX_256 = /^[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hasUnsafeControlCharacter = (value: string) =>
  Array.from(value).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);

interface VaultStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

function validateIdentity(identity: DeviceCredentialIdentity): DeviceCredentialIdentity {
  if (!UUID.test(identity.tenantId) || !UUID.test(identity.branchId)) {
    throw new Error('Trusted device tenant and branch must be UUIDs');
  }
  const deviceUid = identity.deviceUid.trim();
  if (!deviceUid || deviceUid.length > 200 || hasUnsafeControlCharacter(deviceUid)) {
    throw new Error('Trusted device UID is invalid');
  }
  return { tenantId: identity.tenantId, branchId: identity.branchId, deviceUid };
}

function readIdentity(value: unknown): DeviceCredentialIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.tenantId !== 'string' || typeof candidate.branchId !== 'string' || typeof candidate.deviceUid !== 'string') return null;
  try {
    return validateIdentity({ tenantId: candidate.tenantId, branchId: candidate.branchId, deviceUid: candidate.deviceUid });
  } catch {
    return null;
  }
}

/**
 * Main-process-only vault for the terminal credential.
 * The encrypted blob may be persisted in electron-store, but plaintext must never
 * cross the preload bridge, be logged, or be written to renderer storage.
 */
export class DeviceCredentialVault {
  constructor(private readonly store: VaultStore) {}

  status(): DeviceCredentialStatus {
    const protectedByOs = safeStorage.isEncryptionAvailable();
    const ciphertext = this.store.get(CREDENTIAL_KEY);
    const identity = readIdentity(this.store.get(IDENTITY_KEY));
    if (typeof ciphertext !== 'string' || !ciphertext || !identity) {
      return { configured: false, protectedByOs };
    }
    return { configured: true, protectedByOs, ...identity };
  }

  /** Called only by trusted main-process provisioning code after server activation. */
  storeActivatedCredential(identityInput: DeviceCredentialIdentity, credential: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential protection is unavailable');
    }
    if (!HEX_256.test(credential)) {
      throw new Error('Trusted device credential must be a 256-bit hexadecimal value');
    }
    const identity = validateIdentity(identityInput);
    const ciphertext = safeStorage.encryptString(credential).toString('base64');
    this.store.set(CREDENTIAL_KEY, ciphertext);
    this.store.set(IDENTITY_KEY, identity);
  }

  /** Main-process financial RPC code may consume the secret; renderer code may not. */
  readForAuthority(identityInput: DeviceCredentialIdentity): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential protection is unavailable');
    }
    const expected = validateIdentity(identityInput);
    const actual = readIdentity(this.store.get(IDENTITY_KEY));
    const ciphertext = this.store.get(CREDENTIAL_KEY);
    if (!actual || typeof ciphertext !== 'string' || !ciphertext) {
      throw new Error('Trusted device credential is not configured');
    }
    if (actual.tenantId !== expected.tenantId || actual.branchId !== expected.branchId || actual.deviceUid !== expected.deviceUid) {
      throw new Error('Trusted device identity mismatch');
    }
    let credential: string;
    try {
      credential = safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
    } catch {
      throw new Error('Trusted device credential cannot be decrypted');
    }
    if (!HEX_256.test(credential)) {
      throw new Error('Trusted device credential is corrupt');
    }
    return credential;
  }

  clear(): void {
    this.store.delete(CREDENTIAL_KEY);
    this.store.delete(IDENTITY_KEY);
  }
}
