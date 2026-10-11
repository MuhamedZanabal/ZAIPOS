import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222'); const p = b.contexts()[0].pages()[0];
for (let i = 0; i < 5; i++) {
  const btn = p.getByRole('button', { name: /^(Next|Finish|Open the register|Go to POS|Start selling|Finish setup)/i }).last();
  if (!(await btn.count())) break;
  console.log('click', await btn.innerText()); await btn.click(); await p.waitForTimeout(4000);
}
console.log(p.url()); console.log((await p.innerText('body')).slice(0, 500));
process.exit(0);
