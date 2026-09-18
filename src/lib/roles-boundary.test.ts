import { describe, expect, it } from 'vitest';
import { rolesForPath } from './roles';

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
});
