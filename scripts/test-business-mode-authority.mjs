import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/20260924103000_authoritative_business_mode.sql', 'utf8');
const onboarding = readFileSync('src/pages/Onboarding.tsx', 'utf8');
const context = readFileSync('src/hooks/useTenantContext.ts', 'utf8');
const sidebar = readFileSync('src/components/layout/AppSidebar.tsx', 'utf8');
const protectedRoute = readFileSync('src/components/layout/ProtectedRoute.tsx', 'utf8');

assert.match(migration, /business_mode[^;]+CHECK[^;]+RETAIL[^;]+RESTAURANT/is);
assert.match(migration, /bootstrap_tenant_v2[\s\S]+_business_mode/);
assert.match(migration, /assert_restaurant_tenant_v1/);
assert.match(migration, /table_orders[\s\S]+table_order_items[\s\S]+tables/);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.bootstrap_tenant_v2/);
assert.match(onboarding, /businessMode/);
assert.match(onboarding, /bootstrap_tenant_v2/);
assert.match(context, /business_mode/);
assert.match(sidebar, /businessMode/);
assert.match(protectedRoute, /canAccessBusinessMode/);

console.log('PASS authoritative RETAIL | RESTAURANT configuration and client guards');
