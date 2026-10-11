import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222'); const p = b.contexts()[0].pages()[0];
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const S = (n) => p.screenshot({ path: `/workspace/omega/sprint/screens/prod2_${n}.png` });
const go = async (h) => { await p.evaluate((x) => { location.hash = x; }, h); await p.waitForTimeout(2500); };
await go('#/pos');
await p.getByTestId('language-toggle').click(); await p.waitForTimeout(1200);
console.log('POS dir', await p.evaluate(() => document.documentElement.dir), (await p.innerText('body')).slice(0, 200).replace(/\n/g, ' | '));
await S('04_pos_header_toggle_arabic');
await p.reload(); await p.waitForTimeout(4000);
console.log('persisted', await p.evaluate(() => document.documentElement.dir));
for (const [h, n] of [['#/products', '05_products_ar'], ['#/inventory', '06_inventory_ar'], ['#/settings', '07_settings_ar'], ['#/tables', '08_tables_ar'], ['#/kds', '09_kds_ar'], ['#/customers', '10_customers_ar'], ['#/suppliers', '11_suppliers_ar'], ['#/reports', '12_reports_ar'], ['#/delivery', '13_delivery_ar'], ['#/expenses', '14_expenses_ar']]) {
  await go(h); await S(n);
  const t = await p.innerText('main').catch(() => p.innerText('body'));
  const ar = (t.match(/[\u0600-\u06FF]+/g) || []).length, en = (t.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  console.log(n, 'arabicWords', ar, 'latinWords', en);
}
await go('#/pos'); await p.getByTestId('language-toggle').click(); await p.waitForTimeout(800);
await S('15_pos_english'); console.log('back', await p.evaluate(() => document.documentElement.dir));
console.log('pageerrors', errs);
process.exit(0);
