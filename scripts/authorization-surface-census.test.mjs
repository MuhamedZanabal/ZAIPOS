import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scanSource } from './test-authorization-surface-census.mjs';

const simplify = (surfaces) => surfaces.map(({ kind, identifier, scope, line }) => ({
  kind,
  identifier,
  scope,
  line,
}));

test('detects a multiline static RPC and records its operation name', () => {
  const source = `const result = await admin.rpc(\n  "prepare_employee_pos_pin_v1",\n  { employee_id }\n+);`;

  assert.deepEqual(simplify(scanSource('supabase/functions/pos-pin/index.ts', source)), [{
    kind: 'rpc-client',
    identifier: 'prepare_employee_pos_pin_v1',
    scope: 'runtime',
    line: 1,
  }]);
});

test('fails discovery closed by inventorying a dynamic RPC expression', () => {
  const source = 'const result = await supabase.rpc(POS_CHECKOUT_RPC, payload);';

  assert.deepEqual(simplify(scanSource('src/modules/pos/POS.tsx', source)), [{
    kind: 'rpc-client-dynamic',
    identifier: 'POS_CHECKOUT_RPC',
    scope: 'runtime',
    line: 1,
  }]);
});

test('inventories route declarations and ignores wrapper routes without paths', () => {
  const source = `<Route element={<ProtectedRoute />}>\n  <Route\n    path="/reports"\n    element={<Reports />}\n  />\n</Route>`;

  assert.deepEqual(simplify(scanSource('src/App.tsx', source)), [{
    kind: 'application-route',
    identifier: '/reports',
    scope: 'runtime',
    line: 2,
  }]);
});

test('inventories browser download boundaries as data exports', () => {
  const source = `const link = document.createElement('a');\nlink.download = filename;\nlink.click();`;

  assert.deepEqual(simplify(scanSource('src/lib/csv.ts', source)), [{
    kind: 'data-export',
    identifier: 'link.download',
    scope: 'runtime',
    line: 2,
  }]);
});

test('classifies test and migration evidence separately from runtime surfaces', () => {
  const testSurface = scanSource('src/lib/example.test.ts', "supabase.rpc('test_only')");
  const migrationSurface = scanSource(
    'supabase/migrations/20260101000000_example.sql',
    'CREATE FUNCTION public.example() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
  );

  assert.equal(testSurface[0].scope, 'verification');
  assert.equal(migrationSurface[0].scope, 'migration');
});

test('normalizes multiline evidence so line-only formatting changes do not alter text', () => {
  const compact = scanSource('src/example.ts', "supabase.rpc('example', { id })");
  const multiline = scanSource('src/example.ts', "supabase.rpc(\n  'example',\n  { id },\n)");

  assert.equal(compact[0].text, multiline[0].text);
});

test('preserves the established IPC, Edge Function, SQL and navigation surfaces', () => {
  const typescript = `ipcMain.handle('print', handler);\n` +
    `ipcRenderer.invoke('print');\n` +
    `Deno.serve(handler);\n` +
    `shell.openExternal(url);`;
  const sql = `CREATE OR REPLACE FUNCTION public.checkout() RETURNS void SECURITY DEFINER LANGUAGE sql AS $$ SELECT 1 $$;\n` +
    `CREATE POLICY "checkout read" ON public.sales FOR SELECT USING (true);`;

  assert.deepEqual(
    scanSource('supabase/functions/checkout/index.ts', typescript).map(({kind}) => kind),
    ['ipc-main', 'ipc-renderer', 'edge-function', 'external-navigation'],
  );
  assert.deepEqual(
    scanSource('supabase/migrations/20260101000000_checkout.sql', sql).map(({kind}) => kind),
    ['sql-function', 'security-definer', 'rls-policy'],
  );
});

test('inventories trusted IPC wrapper registrations as main-process handlers', () => {
  const source = `handleTrustedIpc(\n  IPC_HANDLERS.PRINT_TICKET,\n  async (_event, ticket) => print(ticket),\n+);`;

  assert.deepEqual(simplify(scanSource('electron/main.ts', source)), [{
    kind: 'ipc-main',
    identifier: 'IPC_HANDLERS.PRINT_TICKET',
    scope: 'runtime',
    line: 1,
  }]);
});

test('does not misclassify trusted IPC wrapper definitions as registrations', () => {
  const source = `export function handleTrustedIpc(channel: string, handler: Handler): void {\n` +
    `  ipcMain.handle(channel, handler);\n` +
    `}`;

  assert.deepEqual(simplify(scanSource('electron/security.ts', source)), [{
    kind: 'ipc-main',
    identifier: 'channel',
    scope: 'runtime',
    line: 2,
  }]);
});

test('production runtime RPC call sites expose concrete operation names', () => {
  const productionFiles = [
    'src/lib/cashMovementRecovery.ts',
    'src/modules/pos/POS.tsx',
  ];
  const dynamic = productionFiles.flatMap((path) =>
    scanSource(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
      .filter((surface) => surface.kind === 'rpc-client-dynamic'),
  );

  assert.deepEqual(dynamic, []);
});
