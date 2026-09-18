import { describe, expect, it } from 'vitest';
import { canAccessRoles, rolesForPath } from './roles';

const legitimateRoles = ['owner', 'admin', 'manager', 'cashier', 'waiter', 'kitchen', 'inventory', 'courier', 'staff'];

describe('protected landing and AI routes', () => {
  for (const path of ['/dashboard', '/ai']) {
    it(`${path} requires an explicit nonempty role declaration and denies a roleless user`, () => {
      expect(rolesForPath(path)).toEqual(legitimateRoles);
      expect(canAccessRoles([], rolesForPath(path))).toBe(false);
      expect(canAccessRoles(['cashier'], rolesForPath(path))).toBe(true);
      expect(canAccessRoles(['super_admin'], rolesForPath(path))).toBe(true);
    });
  }
});
