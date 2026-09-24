import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  EDGE_FUNCTION_AUTHORITY,
  EVIDENCE_CATALOG,
  EXPECTED_RUNTIME_OCCURRENCES,
  POLICIES,
  REQUIRED_NEGATIVE_DIMENSIONS,
  classifyRuntimeSurfaces,
  validatePolicies,
} from './authorization-runtime-contract.mjs';
import { scanSource } from './test-authorization-surface-census.mjs';

function census() {
  const tracked = execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const candidates = tracked.filter(path => /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/.test(path)
    && !path.startsWith('node_modules/') && !path.includes('/dist/'));
  return candidates.flatMap(path => {
    let body;
    try { body = execFileSync('git',['show',`HEAD:${path}`],{encoding:'utf8',maxBuffer:32*1024*1024}); }
    catch { return []; }
    return scanSource(path, body);
  });
}

test('all evidence references resolve to concrete tracked repository files', () => {
  validatePolicies();
  for (const [label, paths] of Object.entries(EVIDENCE_CATALOG)) {
    assert.ok(Array.isArray(paths) && paths.length > 0, label);
    for (const path of paths) assert.equal(existsSync(path), true, `${label}: missing ${path}`);
  }
});

test('all runtime authorization occurrences have an explicit authority policy', () => {
  validatePolicies();
  const surfaces = census();
  const runtime = surfaces.filter(surface => surface.scope === 'runtime');
  assert.equal(runtime.length, EXPECTED_RUNTIME_OCCURRENCES);
  const classified = classifyRuntimeSurfaces(surfaces);
  assert.equal(classified.length, EXPECTED_RUNTIME_OCCURRENCES);
  assert.equal(classified.filter(entry => !POLICIES[entry.policy]).length, 0);
});

test('every runtime policy declares positive and all required negative evidence dimensions', () => {
  validatePolicies();
  for (const [name, policy] of Object.entries(POLICIES)) {
    assert.ok(policy.positive.length > 0, name);
    for (const dimension of REQUIRED_NEGATIVE_DIMENSIONS) {
      assert.ok(policy.negative[dimension]?.length > 0, `${name}: ${dimension}`);
    }
  }
});

test('all ten Edge Functions have explicit authentication, scope and adversarial declarations', () => {
  const surfaces = census().filter(surface => surface.scope === 'runtime' && surface.kind === 'edge-function');
  assert.equal(surfaces.length, 10);
  assert.deepEqual(
    surfaces.map(surface => surface.path).sort(),
    Object.keys(EDGE_FUNCTION_AUTHORITY).sort(),
  );
  for (const surface of surfaces) {
    const entry = EDGE_FUNCTION_AUTHORITY[surface.path];
    assert.ok(entry.authentication);
    assert.ok(Array.isArray(entry.roles));
    assert.equal(typeof entry.serviceRole, 'boolean');
    assert.ok(entry.positive.length > 0);
    for (const dimension of REQUIRED_NEGATIVE_DIMENSIONS) assert.ok(entry.negative[dimension]?.length > 0);
  }
});

test('all fifteen privileged-credential census hits are accounted for and only eleven are runtime custody', () => {
  const surfaces = census().filter(surface => surface.kind === 'privileged-credential');
  const runtime = surfaces.filter(surface => surface.scope === 'runtime');
  const verification = surfaces.filter(surface => surface.scope === 'verification');
  assert.equal(surfaces.length, 15);
  assert.equal(runtime.length, 11);
  assert.equal(verification.length, 4);
  for (const surface of runtime) {
    assert.equal(EDGE_FUNCTION_AUTHORITY[surface.path]?.serviceRole, true, surface.path);
  }
  for (const surface of verification) {
    assert.match(surface.path, /^(?:scripts\/|src\/.*(?:test|spec))/);
  }
});

test('lexical false positives remain explicitly classified instead of disappearing from the census', () => {
  const classified = classifyRuntimeSurfaces(census());
  const falsePositives = classified.filter(entry => entry.policy === 'scanner-false-positive');
  assert.equal(falsePositives.length, 31);
  assert.ok(falsePositives.some(entry => entry.path === 'electron/device-credential-vault.ts'));
  assert.ok(falsePositives.some(entry => entry.kind === 'sql-revoke'));
});

test('classification output binds every duplicate occurrence with a stable ordinal', () => {
  const classified = classifyRuntimeSurfaces(census());
  const keys = classified.map(entry => [entry.kind,entry.path,entry.identifier,entry.occurrence].join('|'));
  assert.equal(new Set(keys).size, classified.length);
});
