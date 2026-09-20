import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

function classifyPath(path) {
  if (/^(?:supabase\/migrations\/|supabase\/schema\.sql$)/.test(path)) return 'migration';
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)scripts\//.test(path)) return 'verification';
  if (path.startsWith('src/') || path.startsWith('electron/') || path.startsWith('supabase/functions/')) return 'runtime';
  return 'support';
}

function normalizeExpression(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function staticString(value) {
  const match = normalizeExpression(value).match(/^(['"`])([A-Za-z0-9_./:-]+)\1(?:\s+as\s+\w+)?$/);
  return match?.[2] ?? null;
}

export function scanSource(path, body) {
  if (typeof path !== 'string' || !path || typeof body !== 'string') throw new TypeError('scanSource requires a path and source text');
  const scope = classifyPath(path);
  const found = [];
  const add = (kind, identifier, index, text = `${kind}(${identifier})`) => {
    found.push({
      kind,
      scope,
      path,
      line: body.slice(0, index).split('\n').length,
      identifier: normalizeExpression(identifier),
      text: normalizeExpression(text),
      index,
    });
  };
  const collect = (regex, visit) => {
    regex.lastIndex = 0;
    for (const match of body.matchAll(regex)) visit(match);
  };

  collect(/\.\s*rpc\s*\(\s*([^,\n)]+)/g, (match) => {
    const expression = normalizeExpression(match[1]);
    const operation = staticString(expression);
    add(operation ? 'rpc-client' : 'rpc-client-dynamic', operation ?? expression, match.index);
  });

  collect(/\bipcMain\s*\.\s*(handle|on)\s*\(\s*([^,\n)]+)/g, (match) => {
    add('ipc-main', staticString(match[2]) ?? match[2], match.index);
  });
  collect(/\b(handleTrustedIpc|handleManagerIpc)\s*\(\s*([^,\n)]+)/g, (match) => {
    if (/\bfunction\s*$/.test(body.slice(Math.max(0, match.index - 40), match.index))) return;
    add('ipc-main', staticString(match[2]) ?? match[2], match.index);
  });
  collect(/\bipcRenderer\s*\.\s*(invoke|send|on)\s*\(\s*([^,\n)]+)/g, (match) => {
    add('ipc-renderer', staticString(match[2]) ?? match[2], match.index);
  });

  if (path.includes('supabase/functions/')) {
    collect(/\b(?:Deno\s*\.\s*serve|serve)\s*\(/g, (match) => add('edge-function', path, match.index));
  }
  collect(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)/gi, (match) => {
    add('sql-function', match[1].replaceAll('"', ''), match.index);
  });
  collect(/\bCREATE\s+POLICY\s+("[^"]+"|[A-Za-z0-9_]+)/gi, (match) => {
    add('rls-policy', match[1].replaceAll('"', ''), match.index);
  });
  collect(/\bSECURITY\s+DEFINER\b/gi, (match) => add('security-definer', 'SECURITY DEFINER', match.index));

  collect(/\b(?:window\s*\.\s*open|shell\s*\.\s*openExternal)\s*\(/g, (match) => {
    add('external-navigation', normalizeExpression(match[0]).replace(/\s*\($/, ''), match.index);
  });
  collect(/<Route\b[^>]*\bpath\s*=\s*(['"])([^'"]+)\1/gms, (match) => {
    add('application-route', match[2], match.index);
  });
  collect(/\b([A-Za-z_$][\w$]*)\s*\.\s*download\s*=/g, (match) => {
    add('data-export', `${match[1]}.download`, match.index);
  });

  return found.sort((a, b) => a.index - b.index || a.kind.localeCompare(b.kind)).map(({index: _index, ...surface}) => surface);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = execFileSync('git', ['ls-files'], {encoding:'utf8'}).trim().split('\n').filter(Boolean);
  const textExtensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/;
  const candidates = tracked.filter(p => textExtensions.test(p) && !p.startsWith('node_modules/') && !p.includes('/dist/'));
  const read = p => execFileSync('git', ['show', `HEAD:${p}`], {encoding:'utf8', maxBuffer: 32 * 1024 * 1024});
  const surfaces = [];
  for (const path of candidates) {
    let body; try { body = read(path); } catch { continue; }
    surfaces.push(...scanSource(path, body));
  }
  assert.ok(surfaces.length > 0, 'authorization census unexpectedly found no security-sensitive surfaces');
  const counts = Object.fromEntries([...new Set(surfaces.map(s=>s.kind))].sort().map(k=>[k,surfaces.filter(s=>s.kind===k).length]));
  const scopes = Object.fromEntries([...new Set(surfaces.map(s=>s.scope))].sort().map(k=>[k,surfaces.filter(s=>s.scope===k).length]));
  console.log(JSON.stringify({schema:2,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),counts,scopes,surfaces},null,2));
}
