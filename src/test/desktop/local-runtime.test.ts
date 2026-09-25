import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalRuntime, adoptInstalledProfile, type LocalProfileStore, type LocalTransport } from '../../../electron/services/local-runtime';
import type { ServerProfile } from '../../../electron/services/local-service-client';
import { pinnedRequest } from '../../../electron/services/local-service-tls';

const GOOD_PIN = 'a'.repeat(64);

function memoryStore(): LocalProfileStore & { saved: ServerProfile | null } {
  const store = { saved: null as ServerProfile | null, read: () => store.saved, write: (profile: ServerProfile) => { store.saved = profile; } };
  return store;
}

describe('installed local runtime', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('does not keep a server profile when the CA fingerprint is wrong', async () => {
    const store = memoryStore();
    const transport: LocalTransport = { request: async () => { throw new Error('LOCAL_CA_MISMATCH'); } };
    const runtime = createLocalRuntime(store, transport);
    await expect(runtime.connect({ origin: 'https://127.0.0.1:8443', caFingerprint: GOOD_PIN })).rejects.toThrow('LOCAL_CA_MISMATCH');
    expect(store.saved).toBeNull();
    await expect(runtime.request('/v1/health')).rejects.toThrow('LOCAL_RUNTIME_NOT_CONFIGURED');
  });

  it('stores a profile only after pinned health and still refuses business calls before enrollment', async () => {
    const store = memoryStore();
    const calls: string[] = [];
    const transport: LocalTransport = {
      request: async (_profile, path) => {
        calls.push(path);
        return { status: 200, body: { status: 'starting', database: 'unavailable' } };
      },
    };
    const runtime = createLocalRuntime(store, transport);
    await runtime.connect({ origin: 'https://10.0.0.8:8443', caFingerprint: GOOD_PIN });
    expect(store.saved?.origin).toBe('https://10.0.0.8:8443');
    await expect(runtime.request('/v1/commands/checkout')).rejects.toThrow('LOCAL_RUNTIME_NOT_CONFIGURED');
    expect(calls).toEqual(['/v1/health']);
    const enrolled = runtime.enroll();
    expect(enrolled.certificateRef).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(enrolled)).not.toMatch(/PRIVATE|privateKey/);
    expect(runtime.signChallenge(new TextEncoder().encode('challenge')).byteLength).toBeGreaterThan(0);
    expect(() => runtime.subscribe()).toThrow('LOCAL_RUNTIME_NOT_CONFIGURED');
  });

  it('adopts the installed server profile and keeps an existing terminal profile', () => {
    const installed = { origin: 'https://127.0.0.1:58321' as const, caFingerprint: GOOD_PIN, deviceCertificateRef: 'local-server-terminal' };
    expect(adoptInstalledProfile(null, installed)).toEqual({ profile: installed, persist: true });
    expect(adoptInstalledProfile(installed, { ...installed, origin: 'https://10.1.1.8:58321' }).persist).toBe(false);
    expect(adoptInstalledProfile(null, { origin: 'https://8.8.8.8' }).profile).toBeNull();
  });

  it('sends the renderer session as a request header instead of the service body', async () => {
    const store = memoryStore();
    store.write({ origin: 'https://127.0.0.1:58321', caFingerprint: GOOD_PIN, deviceCertificateRef: 'local-server-terminal' });
    const seen: Array<{ path: string; body: unknown; authorization?: string }> = [];
    const transport: LocalTransport = {
      request: async (_profile, path, _signal, body, authorization) => {
        seen.push({ path, body, authorization });
        return { status: 200, body: { data: [] } };
      },
    };
    const token = 'a'.repeat(64);
    await createLocalRuntime(store, transport).request('/v1/backend', undefined, {
      zaiposSession: token,
      zaiposPayload: { kind: 'rpc', fn: 'ping_local', args: {} },
    });
    expect(seen).toEqual([{ path: '/v1/backend', body: { kind: 'rpc', fn: 'ping_local', args: {} }, authorization: token }]);
  });

  it('talks only to the pinned local certificate and does not send HTTP to the wrong one', async () => {
    const good = await startServer();
    const evil = await startServer();
    servers.push(good, evil);
    const profile = { origin: `https://127.0.0.1:${good.port}` as const, caFingerprint: good.fingerprint, deviceCertificateRef: 'unenrolled' };
    const health = await pinnedRequest(profile, '/v1/health');
    expect(health.body).toEqual({ status: 'starting', database: 'unavailable' });
    expect(good.requests).toBe(1);
    await expect(pinnedRequest({ ...profile, origin: `https://127.0.0.1:${evil.port}` }, '/v1/health')).rejects.toThrow('LOCAL_CA_MISMATCH');
    expect(evil.requests).toBe(0);
  });
});

async function startServer() {
  const directory = mkdtempSync(join(tmpdir(), 'zaipos-tls-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1']);
  const fingerprint = execFileSync('openssl', ['x509', '-in', cert, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' })
    .split('=')[1]
    .trim()
    .replaceAll(':', '')
    .toLowerCase();
  const requests = { count: 0 };
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    requests.count += 1;
    const body = JSON.stringify({ status: 'starting', database: 'unavailable' });
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return {
    port: address.port,
    fingerprint,
    get requests() { return requests.count; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      rmSync(directory, { recursive: true, force: true });
    }),
  };
}
