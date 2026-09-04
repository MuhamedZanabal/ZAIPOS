import fs from 'node:fs';

const required = [
  ['package.json', '"name": "zaipos"'],
  ['package-lock.json', '"name": "zaipos"'],
  ['src/lib/bahrain.ts', 'BHD'],
  ['src/lib/bahrain.ts', 'en-BH'],
  ['src/modules/pos/PaymentDialog.tsx', 'BenefitPay'],
  ['src/lib/channels.ts', 'talabat'],
  ['electron-builder.config.json', 'com.zaipos.pos'],
];

const failures = [];
for (const [file, marker] of required) {
  if (!fs.existsSync(file)) failures.push(`${file}: missing`);
  else if (!fs.readFileSync(file, 'utf8').includes(marker)) failures.push(`${file}: missing ${marker}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('PASS: ZAIPOS Bahrain release invariants present.');
