import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/process-invoice/index.ts', import.meta.url), 'utf8');

test('process-invoice authenticates before parsing attacker-controlled JSON', () => {
  const auth = source.indexOf('req.headers.get("authorization")');
  const parse = source.indexOf('await req.json()');
  assert.ok(auth >= 0 && parse >= 0, 'expected explicit authorization and JSON parsing');
  assert.ok(auth < parse, 'authorization must happen before parsing the invoice body');
});

test('process-invoice rejects oversized bodies and unsupported media before Gemini', () => {
  const provider = source.indexOf('generativelanguage.googleapis.com');
  assert.ok(provider > 0, 'expected Gemini provider boundary');
  const prefix = source.slice(0, provider);
  assert.match(prefix, /MAX_REQUEST_BYTES/);
  assert.match(prefix, /content-length/);
  assert.match(prefix, /ALLOWED_MIME_TYPES/);
  assert.match(prefix, /image\.length\s*>\s*MAX_BASE64_CHARS/);
});

test('process-invoice never returns raw provider or exception details', () => {
  assert.doesNotMatch(source, /error:\s*error\.message/);
  assert.doesNotMatch(source, /error:\s*String\(error\)/);
});
