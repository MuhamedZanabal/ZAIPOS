import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../supabase/functions/embed-knowledge-doc/index.ts', import.meta.url), 'utf8');

test('embedding service-role update remains tenant and branch scoped', () => {
  const update = source.slice(source.indexOf('.update({ embedding: vectorLiteral })'));
  assert.match(update, /\.eq\("id", doc_id\)/);
  assert.match(update, /\.eq\("tenant_id", tenant_id\)/);
  assert.match(update, /\.eq\("branch_id", branch_id\)/);
});

test('embedding boundary never returns raw provider or database details', () => {
  assert.doesNotMatch(source, /OpenRouter error/);
  assert.doesNotMatch(source, /error:\s*updateErr\.message/);
  assert.doesNotMatch(source, /errText/);
});
