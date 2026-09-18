import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('./authorization-permission-contract.json', import.meta.url)));
const expectedRoles = ['super_admin','owner','admin','manager','cashier','waiter','kitchen','inventory','courier','staff'];
const expectedDimensions = ['role','tenant','branch','account_state','session_state','device_state','operation_identity'];
const expectedKinds = ['application-route','data-export','edge-function','ipc-main','ipc-renderer','rpc-client'];

test('permission contract is explicitly fail-closed while classification is incomplete', () => {
  assert.equal(contract.schema, 1);
  assert.equal(contract.status, 'classification-in-progress');
  assert.equal(contract.default, 'deny-unclassified');
  assert.deepEqual(contract.roles, expectedRoles);
  assert.deepEqual(contract.dimensions, expectedDimensions);
  assert.deepEqual(contract.required_surface_kinds, expectedKinds);
  assert.deepEqual(contract.surfaces, {});
});

test('contract cannot be mistaken for completed authorization acceptance', () => {
  assert.match(contract.meaning, /not proof of enforcement/i);
  assert.notEqual(contract.status, 'verified');
});
