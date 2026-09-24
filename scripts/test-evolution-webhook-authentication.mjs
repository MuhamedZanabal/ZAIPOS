import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../supabase/functions/evolution-webhook/index.ts', import.meta.url), 'utf8');

test('Evolution webhook fails closed when its HMAC secret is unavailable', () => {
  assert.match(source, /const secret = Deno\.env\.get\("EVOLUTION_WEBHOOK_SECRET"\);\s*if \(!secret\) \{/s);
  assert.match(source, /evolution_webhook_secret_missing/);
  assert.match(source, /Webhook authentication unavailable/);
});

test('Evolution webhook requires HMAC verification for every authenticated POST', () => {
  assert.doesNotMatch(source, /if \(secret\) \{\s*const signature/s);
  assert.match(source, /const signature = req\.headers\.get\("x-webhook-signature"\) \?\? req\.headers\.get\("x-evolution-signature"\);\s*const validSignature = await verifyHmacSha256\(secret, `\$\{timestamp\}\.\$\{rawBody\}`, signature\);\s*if \(!validSignature\) \{/s);
});

test('Evolution webhook authenticates before JSON parsing and service-role tenant lookup', () => {
  const missingSecret = source.indexOf('if (!secret)');
  const signatureVerification = source.indexOf('const validSignature = await verifyHmacSha256');
  const parse = source.indexOf('payload = JSON.parse(rawBody)');
  const tenantLookup = source.indexOf('.from("ai_channel_configs")');
  assert.ok(missingSecret >= 0 && signatureVerification > missingSecret);
  assert.ok(parse > signatureVerification, 'JSON parsing must happen after HMAC verification');
  assert.ok(tenantLookup > parse, 'service-role tenant lookup must happen after authentication');
});

