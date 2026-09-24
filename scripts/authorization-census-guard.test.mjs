import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validate } from './authorization-census-guard.mjs';

const record = (
  kind,
  identifier,
  path = 'src/example.ts',
  line = 1,
  scope = 'runtime',
) => ({kind, identifier, path, line, scope, text: `${kind}(${identifier})`});
const known = [
  record('rpc-client', 'sale_operation'),
  record('edge-function', 'supabase/functions/sale/index.ts', 'supabase/functions/sale/index.ts'),
];
const baseline = {schema:2, kinds:summarize(known)};

test('reordering and line-only movement do not invalidate a baseline', () => {
  const reordered = known.map(item=>({...item,line:item.line+9})).reverse();
  assert.deepEqual(validate(reordered, baseline), []);
});
test('a new occurrence fails closed even when the matching surface already exists', () => {
  assert.match(validate([...known, known[0]],baseline).join('\n'), /rpc-client/);
});
test('a substituted identifier fails despite identical total counts', () => {
  assert.match(validate([record('rpc-client','refund_operation'),known[1]],baseline).join('\n'), /rpc-client/);
});
test('a runtime surface reclassified as verification evidence fails closed', () => {
  assert.match(validate([{...known[0],scope:'verification'},known[1]],baseline).join('\n'), /rpc-client/);
});
test('a newly detected kind fails rather than being silently ignored', () => {
  assert.match(validate([...known,record('ipc-main','print')],baseline).join('\n'), /ipc-main/);
});
test('removed surfaces fail rather than disappearing without review', () => {
  assert.match(validate(known.slice(1),baseline).join('\n'), /rpc-client/);
});
test('obsolete or malformed baseline schemas fail closed', () => {
  assert.throws(()=>validate(known,{schema:1,kinds:baseline.kinds}), /schema/);
  assert.throws(()=>validate(known,{schema:2,kinds:{}}), /schema/);
});
test('malformed surface data fails closed', () => {
  assert.throws(()=>summarize([{kind:'rpc-client',path:'',text:'whatever'}]), /surface/);
  assert.throws(()=>summarize([{...known[0],scope:'unknown'}]), /surface/);
});
