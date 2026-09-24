import { describe, expect, it } from 'vitest';
import { canAccessBusinessMode, canAccessProtectedPath, rolesForPath } from './roles';

describe('route permission prefix boundaries', () => {
  it('does not mistake a sibling route name for a protected child route', () => {
    expect(rolesForPath('/cashier')).toBeUndefined();
    expect(rolesForPath('/reports-archive')).toBeUndefined();
    expect(rolesForPath('/dashboarding')).toBeUndefined();
    expect(rolesForPath('/posh')).toBeUndefined();
  });

  it('retains exact and nested route permission matching', () => {
    expect(rolesForPath('/cash')).toEqual(['owner', 'admin', 'manager', 'cashier']);
    expect(rolesForPath('/cash/history')).toEqual(['owner', 'admin', 'manager', 'cashier']);
    expect(rolesForPath('/reports/export')).toEqual(['owner', 'admin', 'manager']);
    expect(rolesForPath('/onboarding')).toBeUndefined();
  });

  it('denies undeclared protected paths to every role, including super administrators', () => {
    for (const path of ['/cashier', '/reports-archive', '/dashboarding', '/posh', '/new-module']) {
      expect(canAccessProtectedPath(['owner'], path)).toBe(false);
      expect(canAccessProtectedPath(['super_admin'], path)).toBe(false);
      expect(canAccessProtectedPath([], path)).toBe(false);
    }
  });

  it('permits declared protected paths only for an allowed role or the explicit super administrator override', () => {
    expect(canAccessProtectedPath(['cashier'], '/cash/history')).toBe(true);
    expect(canAccessProtectedPath(['cashier'], '/reports/export')).toBe(false);
    expect(canAccessProtectedPath(['manager'], '/reports/export')).toBe(true);
    expect(canAccessProtectedPath(['super_admin'], '/reports/export')).toBe(true);
    expect(canAccessProtectedPath([], '/dashboard')).toBe(false);
  });
});

describe('business mode route authority', () => {
  it('denies restaurant-only routes to RETAIL tenants', () => {
    for (const path of ['/tables', '/tables/one', '/waiter', '/kds', '/recipes']) {
      expect(canAccessBusinessMode('RETAIL', path)).toBe(false);
    }
  });

  it('keeps retail operations available and admits restaurant routes only in RESTAURANT mode', () => {
    expect(canAccessBusinessMode('RETAIL', '/pos')).toBe(true);
    expect(canAccessBusinessMode('RETAIL', '/inventory')).toBe(true);
    expect(canAccessBusinessMode('RESTAURANT', '/tables')).toBe(true);
    expect(canAccessBusinessMode('RESTAURANT', '/kds')).toBe(true);
  });
});
