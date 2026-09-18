import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanSource } from './test-authorization-surface-census.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const contract = JSON.parse(read('./authorization-permission-contract.json'));
const expectedRoles = ['super_admin','owner','admin','manager','cashier','waiter','kitchen','inventory','courier','staff'];
const expectedDimensions = ['role','tenant','branch','account_state','session_state','device_state','operation_identity'];
const expectedKinds = ['application-route','data-export','edge-function','ipc-main','ipc-renderer','rpc-client'];
const app = read('../src/App.tsx');
const roleSource = read('../src/lib/roles.ts');
const publicRoutes = new Set(['/', '/auth', '/403', '/qr/:branchId', '*']);
const rules = [...roleSource.matchAll(/\{\s*prefix:\s*"([^"]+)"\s*,\s*roles:\s*\[([^\]]*)\]\s*\}/g)]
  .map(match => ({prefix: match[1], roles: [...match[2].matchAll(/"([^"]+)"/g)].map(role => role[1])}));
const routeSurfaces = scanSource('src/App.tsx', app).filter(surface => surface.kind === 'application-route');
const routeKey = path => `application-route|src/App.tsx|${path}`;

function expectedRolesForPath(path) {
  const matching = rules.filter(rule => path === rule.prefix || (rule.prefix !== '/' && path.startsWith(`${rule.prefix}/`)))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return matching[0]?.roles;
}

test('permission contract remains explicitly unaccepted until all runtime permissions are reviewed', () => {
  assert.equal(contract.schema, 1);
  assert.equal(contract.status, 'classification-in-progress');
  assert.equal(contract.default, 'deny-unclassified');
  assert.deepEqual(contract.roles, expectedRoles);
  assert.deepEqual(contract.dimensions, expectedDimensions);
  assert.deepEqual(contract.required_surface_kinds, expectedKinds);
  assert.ok(contract.surfaces && typeof contract.surfaces === 'object' && !Array.isArray(contract.surfaces));
  assert.match(contract.meaning, /not proof of enforcement/i);
  assert.notEqual(contract.status, 'verified');
});

test('permission-contract role derivation respects route segment boundaries', () => {
  const cashRoles = rules.find(rule => rule.prefix === '/cash')?.roles;
  assert.ok(cashRoles?.length, 'expected /cash role policy');
  assert.deepEqual(expectedRolesForPath('/cash'), cashRoles);
  assert.deepEqual(expectedRolesForPath('/cash/history'), cashRoles);
  assert.equal(expectedRolesForPath('/cashier'), undefined, '/cash must not authorize sibling /cashier');
});

test('every currently discovered application route has one explicit UI policy declaration', () => {
  assert.equal(new Set(routeSurfaces.map(surface => surface.identifier)).size, routeSurfaces.length, 'ambiguous duplicate route');
  const expectedKeys = routeSurfaces.map(surface => routeKey(surface.identifier)).sort();
  const declaredKeys = Object.keys(contract.surfaces).sort();
  assert.deepEqual(declaredKeys, expectedKeys, 'missing, stale or unreviewed authorization-sensitive route');
  assert.deepEqual([...publicRoutes].filter(path => !routeSurfaces.some(surface => surface.identifier === path)), [], 'stale public route allowlist');
});

test('declared route UI roles match current route guards without claiming server enforcement', () => {
  assert.ok(rules.length > 0, 'role source parsing must not silently yield no guards');
  // Spell the JSX tag with a character class to avoid the lexical census mistaking this test regex for an application route.
  const publicInSource = [...app.slice(0, app.indexOf('<Route element={<ProtectedRoute />}>')).matchAll(/<Rout[e]\s+path="([^"]+)"/g)].map(match => match[1]);
  assert.ok(publicInSource.length > 0, 'protected route wrapper not detected');
  assert.deepEqual(publicInSource.sort(), [...publicRoutes].filter(path => path !== '*').sort(), 'unexpected unauthenticated route');
  for (const {identifier: path} of routeSurfaces) {
    const declared = contract.surfaces[routeKey(path)];
    assert.equal(declared.server_authorization, 'not-assessed', `${path}: UI checks cannot certify backend authority`);
    if (publicRoutes.has(path)) {
      assert.equal(declared.ui_access, 'public', path);
      assert.deepEqual(declared.ui_roles, [], path);
    } else if (path === '/onboarding') {
      assert.equal(declared.ui_access, 'authenticated', path);
      assert.deepEqual(declared.ui_roles, [], path);
    } else {
      assert.equal(declared.ui_access, 'role-gated', path);
      assert.deepEqual(declared.ui_roles, expectedRolesForPath(path), `${path}: UI role mismatch`);
      assert.equal(declared.super_admin_bypass, true, `${path}: super_admin UI override must be explicit`);
    }
  }
});
