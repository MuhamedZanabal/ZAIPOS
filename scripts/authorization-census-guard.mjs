import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fingerprints freeze discovery results, NOT role approvals or authorization effectiveness.
export function summarize(surfaces) {
  if (!Array.isArray(surfaces) || surfaces.length === 0) throw new Error('Invalid census: surfaces must be nonempty');
  const grouped = new Map();
  for (const surface of surfaces) {
    if (!surface || !['kind', 'scope', 'path', 'identifier', 'text'].every(key =>
      typeof surface[key] === 'string' && surface[key].trim() !== '' && !surface[key].includes('\n')) ||
      !['runtime', 'migration', 'verification', 'support'].includes(surface.scope))
      throw new Error('Invalid census surface: expected a known scope and nonempty single-line fields');
    const signature = `${surface.scope}\0${surface.path}\0${surface.identifier}\0${surface.text}`;
    if (!grouped.has(surface.kind)) grouped.set(surface.kind, []);
    grouped.get(surface.kind).push(signature);
  }
  return Object.fromEntries([...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([kind, entries]) => [kind, {
    count: entries.length,
    sha256: createHash('sha256').update(entries.sort().join('\n')).digest('hex'),
  }]));
}
export function validate(surfaces, baseline) {
  if (baseline?.schema !== 2 || !baseline.kinds || typeof baseline.kinds !== 'object' ||
      Array.isArray(baseline.kinds) || Object.keys(baseline.kinds).length === 0)
    throw new Error('Invalid authorization baseline schema');
  const actual = summarize(surfaces);
  const failures = [];
  for (const kind of [...new Set([...Object.keys(baseline.kinds), ...Object.keys(actual)])].sort()) {
    const expected = baseline.kinds[kind];
    const observed = actual[kind];
    if (!expected || !Number.isSafeInteger(expected.count) || expected.count < 1 ||
        !/^[a-f0-9]{64}$/.test(expected.sha256 ?? ''))
      failures.push(`${kind}: unexpected kind or invalid expected baseline`);
    else if (!observed || observed.count !== expected.count || observed.sha256 !== expected.sha256)
      failures.push(`${kind}: expected ${expected.count} entries (${expected.sha256}), found ${observed?.count ?? 0} (${observed?.sha256 ?? 'absent'})`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const census = JSON.parse(readFileSync(process.argv[2] ?? 'authorization-surface-census.json', 'utf8'));
    const baseline = JSON.parse(readFileSync(process.argv[3] ?? 'scripts/authorization-surface-baseline.json', 'utf8'));
    if (census.schema !== 2 || !Array.isArray(census.surfaces)) throw new Error('Invalid census JSON schema');
    const failures = validate(census.surfaces, baseline);
    if (failures.length) {
      console.error('Authorization census drift detected. Review changed surfaces and update baseline deliberately; fingerprints are NOT permission approvals.');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else console.log(`Authorization census unchanged: ${census.surfaces.length} detected occurrences across ${Object.keys(baseline.kinds).length} kinds (no permission endorsement).`);
  } catch (error) {
    console.error(`Authorization census guard failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
