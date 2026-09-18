import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const tracked = execFileSync('git', ['ls-files'], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
const textExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/;
const candidates = tracked.filter(p => textExtensions.test(p) && !p.startsWith('node_modules/') && !p.includes('/dist/'));
const read = p => execFileSync('git', ['show', `HEAD:${p}`], {encoding:'utf8', maxBuffer: 32 * 1024 * 1024});
const surfaces = [];
const classify = path => path.startsWith('src/') || path.startsWith('electron/') || path.startsWith('supabase/functions/')
  ? 'runtime'
  : path.startsWith('supabase/migrations/') ? 'migration'
  : /(^|\/)(?:test|tests|__tests__|scripts)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ? 'verification'
  : 'support';
for (const path of candidates) {
  let body; try { body = read(path); } catch { continue; }
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    const hits = [];
    if (/\.rpc\s*\(\s*['"`][A-Za-z0-9_]+/.test(line)) hits.push('rpc-client');
    if (/ipcMain\.(?:handle|on)\s*\(/.test(line)) hits.push('ipc-main');
    if (/ipcRenderer\.(?:invoke|send)\s*\(/.test(line)) hits.push('ipc-renderer');
    if (/Deno\.serve\s*\(|serve\s*\(\s*async|serve\s*\(\s*\(/.test(line) && path.includes('supabase/functions/')) hits.push('edge-function');
    if (/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+/i.test(line)) hits.push('sql-function');
    if (/CREATE\s+POLICY\s+/i.test(line)) hits.push('rls-policy');
    if (/SECURITY\s+DEFINER/i.test(line)) hits.push('security-definer');
    if (/window\.open\s*\(|shell\.openExternal\s*\(/.test(line)) hits.push('external-navigation');
    for (const kind of hits) surfaces.push({kind,scope:classify(path),path,line:index+1,text:line.trim().slice(0,240)});
  });
}
assert.ok(surfaces.length > 0, 'authorization census unexpectedly found no security-sensitive surfaces');
const counts = Object.fromEntries([...new Set(surfaces.map(s=>s.kind))].sort().map(k=>[k,surfaces.filter(s=>s.kind===k).length]));
const scopes = Object.fromEntries([...new Set(surfaces.map(s=>s.scope))].sort().map(k=>[k,surfaces.filter(s=>s.scope===k).length]));
console.log(JSON.stringify({schema:1,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),counts,scopes,surfaces},null,2));
