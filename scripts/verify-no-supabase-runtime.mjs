import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
const failures = [];
if (dependencyNames.some((name) => name.startsWith('@supabase/'))) failures.push('package.json still depends on Supabase');

function scan(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) scan(path);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(path) && readFileSync(path, 'utf8').includes('@supabase/')) failures.push(path);
  }
}

for (const directory of ['src', 'electron']) scan(directory);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('production runtime has no Supabase SDK');
