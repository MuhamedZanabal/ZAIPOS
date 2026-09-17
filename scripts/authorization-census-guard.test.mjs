import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, validate } from './authorization-census-guard.mjs';

const record = (kind, text, path='src/example.ts', line=1) => ({kind, path, line, text});
const known = [record('rpc-client', 'sale operation'), record('edge-function', 'Deno.serve(handler)', 'supabase/functions/sale/index.ts')];
const baseline = {schema:1, kinds:summarize(known)};

test('reordering and line-only movement do not invalidate a baseline', () => {
  const reordered = known.map(item=>({...item,line:item.line+9})).reverse();
  assert.deepEqual(validate(reordered, baseline), []);
});
test('a new occurrence fails closed even when the matching line already exists', () => {
  assert.match(validate([...known, known[0]],baseline).join('\n'), /rpc-client/);
});
test('a substituted surface fails despite identical total counts', () => {
  assert.match(validate([record('rpc-client','refund operation'),known[1]],baseline).join('\n'), /rpc-client/);
});
test('a newly detected kind fails rather than being silently ignored', () => {
  assert.match(validate([...known,record('ipc-main','IPC handle')],baseline).join('\n'), /ipc-main/);
});
test('removed surfaces fail rather than disappearing without review', () => {
  assert.match(validate(known.slice(1),baseline).join('\n'), /rpc-client/);
});
test('invalid baseline schema fails closed', () => {
  assert.throws(()=>validate(known,{schema:999,kinds:{}}), /schema/);
});
test('malformed surface data fails closed', () => {
  assert.throws(()=>summarize([{kind:'rpc-client',path:'',text:'whatever'}]), /surface/);
});
