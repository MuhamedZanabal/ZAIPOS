import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const migration = readFileSync(`${root}/supabase/migrations/20260922180215_device_bound_table_checkout.sql`, 'utf8');
const pending = readFileSync(`${root}/src/modules/cash/PendingTableOrders.tsx`, 'utf8');
const table = readFileSync(`${root}/src/modules/tables/TableOrder.tsx`, 'utf8');
const sync = readFileSync(`${root}/src/hooks/useSyncEngine.ts`, 'utf8');

const requireMatch = (label, text, pattern) => { if (!pattern.test(text)) throw new Error(`${label}: missing ${pattern}`); };
const forbid = (label, text, pattern) => { if (pattern.test(text)) throw new Error(`${label}: forbidden ${pattern}`); };

requireMatch('table wrapper requires native device authority', migration, /require_table_checkout_device_v1/);
requireMatch('waiter role remains explicitly classified', migration, /'waiter'[\s\S]*public\.app_role/);
requireMatch('legacy authenticated execution is revoked', migration, /REVOKE ALL ON FUNCTION public\.checkout_table_order[\s\S]*authenticated/);
requireMatch('cashier table checkout uses native bridge', pending, /checkoutTableOrderOnDevice/);
requireMatch('table detail checkout uses native bridge', table, /checkoutTableOrderOnDevice/);
forbid('cashier cannot call legacy financial RPC', pending, /rpc\(["']checkout_table_order["']/);
forbid('table detail cannot call legacy financial RPC', table, /rpc\(["']checkout_table_order["']/);
forbid('sync engine cannot replay table checkout RPC', sync, /rpc\(["']checkout_table_order["']/);

console.log('Device-bound table checkout static contract: PASS');
