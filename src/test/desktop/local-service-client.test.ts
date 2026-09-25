import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { preloadDeviceIdentity, LOCAL_PRELOAD_METHODS } from '../../../electron/services/local-device-key';
import { parseDiscoveryInput } from '../../../electron/services/local-service-discovery';
import {
  createLocalServiceClient,
  localRuntimeStatus,
  parseServerProfile,
  rejectUnprovisionedLocalCall,
  type PinnedTls,
  type ServerProfile,
} from '../../../electron/services/local-service-client';

const GOOD_PIN = 'a'.repeat(64);
const EVIL_PIN = 'b'.repeat(64);

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return parseServerProfile({
    origin: 'https://127.0.0.1:8443',
    caFingerprint: GOOD_PIN,
    deviceCertificateRef: 'terminal-1',
    ...overrides,
  });
}

function fakeTls(input: { fingerprint: string }): PinnedTls {
  return {
    observe: async (origin) => ({ fingerprint: input.fingerprint, hostname: new URL(origin).hostname }),
    request: vi.fn(async () => ({ status: 'starting', database: 'unavailable' })),
  };
}

describe('pinned local-service transport', () => {
  it('rejects the correct hostname with the wrong CA fingerprint', async () => {
    const tls = fakeTls({ fingerprint: EVIL_PIN });
    const client = createLocalServiceClient(profile({ caFingerprint: GOOD_PIN }), tls);
    await expect(client.health()).rejects.toThrow('LOCAL_CA_MISMATCH');
    expect(tls.request).not.toHaveBeenCalled();
  });

  it('accepts a loopback origin only after the pinned fingerprint matches', async () => {
    const tls = fakeTls({ fingerprint: GOOD_PIN });
    const health = await createLocalServiceClient(profile(), tls).health();
    expect(health).toEqual({ status: 'starting', database: 'unavailable' });
  });

  it('rejects public, named, credentialed and plaintext discovery', () => {
    for (const origin of [
      'http://127.0.0.1:8443',
      'https://8.8.8.8:8443',
      'https://store.local:8443',
      'https://user:password@127.0.0.1:8443',
      'https://127.0.0.1:8443/health',
    ]) {
      expect(() => parseDiscoveryInput({ origin, caFingerprint: GOOD_PIN })).toThrow('LOCAL_ORIGIN_REJECTED');
    }
    expect(() => parseDiscoveryInput({ origin: 'https://192.168.1.20:8443', caFingerprint: GOOD_PIN, extra: true })).toThrow(
      'LOCAL_PROFILE_INVALID',
    );
    expect(parseDiscoveryInput({ origin: 'https://10.1.2.3:8443', caFingerprint: GOOD_PIN }).origin).toBe('https://10.1.2.3:8443');
  });

  it('never exposes private key material through the local preload surface', () => {
    const visible = preloadDeviceIdentity({ privateKeyPem: 'secret-material', certificateRef: 'terminal-1' });
    expect(visible).toEqual({ certificateRef: 'terminal-1' });
    expect(JSON.stringify(visible)).not.toMatch(/secret-material|privateKey|databasePassword/);
    expect(LOCAL_PRELOAD_METHODS).not.toContain('getDevicePrivateKey');
    const preload = readFileSync('electron/preload.ts', 'utf8');
    expect(preload).not.toMatch(/getDevicePrivateKey|databasePassword/);
    expect(localRuntimeStatus()).toEqual({ state: 'not_configured' });
    expect(() => rejectUnprovisionedLocalCall()).toThrow('LOCAL_RUNTIME_NOT_CONFIGURED');
  });
});
