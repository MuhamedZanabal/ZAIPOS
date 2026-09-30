import tls from 'node:tls';

const [origin, expectedFingerprint] = process.argv.slice(2);
if (!origin || !/^[a-f0-9]{64}$/i.test(expectedFingerprint ?? '')) {
  console.error('LOCAL_TLS_PROBE_ARGUMENTS_INVALID');
  process.exit(2);
}
const url = new URL(origin);
const expectedHost = url.hostname;
const expected = expectedFingerprint.toLowerCase();

function normalizeAddress(value = '') {
  const lower = value.toLowerCase().replace(/^\[|\]$/g, '');
  return lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
}

function fingerprint256(certificate) {
  let current = certificate;
  const seen = new Set();
  while (current?.issuerCertificate && current.issuerCertificate !== current && !seen.has(current.issuerCertificate)) {
    seen.add(current);
    current = current.issuerCertificate;
  }
  return current?.fingerprint256?.replaceAll(':', '').toLowerCase() ?? '';
}

const socket = tls.connect({
  host: expectedHost,
  port: Number(url.port || 443),
  rejectUnauthorized: false,
  ALPNProtocols: ['http/1.1'],
});

const fail = (message) => {
  console.error(message);
  socket.destroy();
  process.exitCode = 1;
};

socket.setTimeout(5000, () => fail('LOCAL_TLS_PROBE_TIMEOUT'));
socket.once('error', (error) => fail(`LOCAL_TLS_PROBE_ERROR:${error.code ?? error.name}:${error.message}`));
socket.once('secureConnect', () => {
  const actual = fingerprint256(socket.getPeerCertificate(true));
  const remote = normalizeAddress(socket.remoteAddress);
  if (actual !== expected) return fail(`LOCAL_TLS_PROBE_FINGERPRINT_MISMATCH:${actual}`);
  if (remote !== normalizeAddress(expectedHost)) return fail(`LOCAL_TLS_PROBE_HOST_MISMATCH:${remote}`);

  let raw = '';
  socket.on('data', (chunk) => {
    raw += chunk.toString('utf8');
  });
  socket.once('end', () => {
    const split = raw.indexOf('\r\n\r\n');
    if (split < 0) return fail('LOCAL_TLS_PROBE_HTTP_INVALID');
    const header = raw.slice(0, split);
    const body = raw.slice(split + 4);
    const status = Number(header.split('\r\n')[0]?.split(' ')[1]);
    if (status !== 200) return fail(`LOCAL_TLS_PROBE_HTTP_STATUS:${status}`);
    try {
      const health = JSON.parse(body);
      if (health.status !== 'ready' || health.database !== 'ready') return fail('LOCAL_TLS_PROBE_HEALTH_NOT_READY');
      process.stdout.write(JSON.stringify(health));
    } catch (error) {
      fail(`LOCAL_TLS_PROBE_JSON_INVALID:${error.message}`);
    }
  });
  socket.write(`GET /v1/health HTTP/1.1\r\nHost: ${expectedHost}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
});
