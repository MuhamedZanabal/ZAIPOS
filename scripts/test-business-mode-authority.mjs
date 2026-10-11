import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync('supabase/migrations/20260924103000_authoritative_business_mode.sql', 'utf8');
const onboarding = readFileSync('src/pages/Onboarding.tsx', 'utf8');
const context = readFileSync('src/hooks/useTenantContext.ts', 'utf8');
const sidebar = readFileSync('src/components/layout/AppSidebar.tsx', 'utf8');
const protectedRoute = readFileSync('src/components/layout/ProtectedRoute.tsx', 'utf8');
const types = readFileSync('supabase/migrations/20261011100000_business_types_and_setup.sql', 'utf8');
const modes = readFileSync('src/lib/business-modes.ts', 'utf8');

assert.match(migration, /business_mode[^;]+CHECK[^;]+RETAIL[^;]+RESTAURANT/is);
assert.match(migration, /bootstrap_tenant_v2[\s\S]+_business_mode/);
assert.match(migration, /assert_restaurant_tenant_v1/);
assert.match(migration, /table_orders[\s\S]+table_order_items[\s\S]+tables/);
assert.match(migration, /pg_advisory_xact_lock\(hashtext\('zaipos\.bootstrap_tenant_v2'\)\)/);
assert.match(migration, /EXISTS \(SELECT 1 FROM public\.tables[\s\S]+array_remove\(active_channels, 'tables'/);
assert.doesNotMatch(migration, /WHERE 'tables'::public\.sales_channel = ANY\(active_channels\)/);
assert.match(migration, /REVOKE ALL ON FUNCTION public\.bootstrap_tenant_v2/);
assert.match(onboarding, /_business_mode: state\.mode/);
assert.match(onboarding, /bootstrap_tenant_v2/);
assert.match(context, /business_mode/);
assert.match(sidebar, /hasCapability\(businessMode, item\.capability\)/);
assert.match(protectedRoute, /canAccessBusinessMode/);

// Guided setup: four business types, owner-only change, cafés may run tables.
assert.match(types, /CHECK \(business_mode IN \('RETAIL', 'RESTAURANT', 'CAFE', 'SUPERMARKET'\)\)/);
assert.match(types, /change_business_mode_v1[\s\S]+has_any_role\(auth\.uid\(\), _tenant_id, ARRAY\['owner'\]/);
assert.match(types, /current_setting\('zaipos\.business_mode_change', true\)/);
assert.match(types, /business_mode IN \('RESTAURANT', 'CAFE'\)/);
assert.match(types, /REVOKE ALL ON FUNCTION public\.change_business_mode_v1\(uuid,text\) FROM PUBLIC, anon/);
assert.match(types, /REVOKE ALL ON FUNCTION public\.assign_staff_role_v1\(uuid,uuid,text,uuid\) FROM PUBLIC, anon/);
assert.match(modes, /BUSINESS_MODES = \["RESTAURANT", "CAFE", "SUPERMARKET", "RETAIL"\]/);

console.log('PASS authoritative business types (RETAIL | RESTAURANT | CAFE | SUPERMARKET), owner-only change and client guards');
