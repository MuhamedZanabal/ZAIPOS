import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { scanSource } from './test-authorization-surface-census.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const contract = JSON.parse(read('./authorization-permission-contract.json'));
const baseline = JSON.parse(read('./authorization-surface-baseline.json'));
const expectedRoles = ['super_admin','owner','admin','manager','cashier','waiter','kitchen','inventory','courier','staff'];
const expectedDimensions = ['role','tenant','branch','account_state','session_state','device_state','operation_identity'];
const expectedKinds = [
  'application-route','background-job','data-export','edge-function','external-navigation',
  'ipc-main','ipc-renderer','privileged-credential','rls-policy','rpc-client',
  'security-definer','sql-function','sql-grant','sql-revoke','sql-trigger','table-client',
];
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

test('permission contract records verified integrated runtime classification without treating the lexical census as enforcement proof', () => {
  assert.equal(contract.schema, 1);
  assert.equal(contract.status, 'runtime-classification-verified');
  assert.equal(contract.default, 'deny-unclassified');
  assert.deepEqual(contract.roles, expectedRoles);
  assert.deepEqual(contract.dimensions, expectedDimensions);
  assert.deepEqual(contract.required_surface_kinds, expectedKinds);
  assert.ok(contract.surfaces && typeof contract.surfaces === 'object' && !Array.isArray(contract.surfaces));
  assert.match(contract.meaning, /not.*proof of enforcement/i);
  assert.equal(contract.runtime_contract?.file, 'scripts/authorization-runtime-contract.mjs');
  assert.equal(contract.runtime_contract?.integrated_runtime_occurrences, 419);
  assert.equal(contract.runtime_contract?.original_requested_runtime_occurrences, 416);
  assert.equal(contract.runtime_contract?.added_by_integrated_offline_recovery, 3);
  assert.equal(contract.runtime_contract?.default, 'deny-unclassified');
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
  const declaredKeys = Object.keys(contract.surfaces).filter(key => key.startsWith('application-route|')).sort();
  assert.deepEqual(declaredKeys, expectedKeys, 'missing, stale or unreviewed authorization-sensitive route');
  assert.deepEqual([...publicRoutes].filter(path => !routeSurfaces.some(surface => surface.identifier === path)), [], 'stale public route allowlist');
});

test('every Edge Function has an explicit authentication and authority classification', () => {
  const edgeSurfaces = readdirSync(new URL('../supabase/functions/', import.meta.url), {withFileTypes: true})
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .flatMap(entry => {
      try {
        const path = `supabase/functions/${entry.name}/index.ts`;
        return scanSource(path, read(`../${path}`)).filter(surface => surface.kind === 'edge-function');
      } catch {
        return [];
      }
    });
  const expectedKeys = edgeSurfaces.map(surface => `edge-function|${surface.path}|${surface.identifier}`).sort();
  const declaredKeys = Object.keys(contract.surfaces).filter(key => key.startsWith('edge-function|')).sort();
  assert.deepEqual(declaredKeys, expectedKeys, 'missing, stale or unreviewed Edge Function authority');
  for (const key of declaredKeys) {
    const entry = contract.surfaces[key];
    assert.ok(['user-jwt', 'service-role-jwt', 'exact-service-role-secret', 'hmac'].includes(entry.authentication), `${key}: authentication must be explicit`);
    assert.ok(Array.isArray(entry.allowed_roles), `${key}: allowed roles must be explicit`);
    assert.equal(typeof entry.uses_service_role, 'boolean', `${key}: service-role custody must be explicit`);
    assert.ok(Array.isArray(entry.negative_evidence) && entry.negative_evidence.length > 0, `${key}: negative evidence required`);
    assert.notEqual(entry.server_authorization, 'not-assessed', `${key}: Edge Function authority must be assessed`);
  }
});

test('declared route UI roles match current route guards without claiming server enforcement', () => {
  assert.ok(rules.length > 0, 'role source parsing must not silently yield no guards');
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

test('broader lexical census remains non-certifying even after runtime classification is complete', () => {
  const declaredCounts = Object.keys(contract.surfaces).reduce((counts, key) => {
    const kind = key.split('|', 1)[0];
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {});
  const incomplete = contract.required_surface_kinds.filter(kind => {
    const expected = baseline.kinds?.[kind]?.count;
    assert.ok(Number.isSafeInteger(expected) && expected > 0, `${kind}: missing census baseline`);
    return (declaredCounts[kind] ?? 0) < expected;
  });
  assert.ok(incomplete.length > 0, 'the summary contract intentionally does not duplicate every migration/support lexical occurrence');
  assert.equal(contract.status, 'runtime-classification-verified');
  assert.notEqual(contract.status, 'verified', `lexical census alone cannot certify authorization: ${incomplete.join(', ')}`);
});
