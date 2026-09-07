import fs from 'node:fs';
import path from 'node:path';

const builder = JSON.parse(fs.readFileSync('electron-builder.config.json', 'utf8'));
const electronMain = fs.readFileSync('electron/main.ts', 'utf8');
const viteConfig = fs.readFileSync('vite.config.ts', 'utf8');
const iconPath = builder.win?.icon;

if (typeof iconPath !== 'string' || iconPath.length === 0) {
  throw new Error('electron-builder Windows icon path is required');
}

const resolvedPath = path.resolve(iconPath);
const icon = fs.readFileSync(resolvedPath);
const extension = path.extname(resolvedPath).toLowerCase();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validatePng(buffer, label) {
  assert(buffer.length >= 24, `${label}: PNG is truncated`);
  assert(buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), `${label}: invalid PNG signature`);
  assert(buffer.subarray(12, 16).toString('ascii') === 'IHDR', `${label}: missing PNG IHDR`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(width === height && width >= 256, `${label}: Windows source PNG must be square and at least 256px`);
}

if (extension === '.png') {
  validatePng(icon, iconPath);
} else if (extension === '.ico') {
  assert(icon.length >= 22, `${iconPath}: ICO is truncated`);
  assert(icon.readUInt16LE(0) === 0 && icon.readUInt16LE(2) === 1, `${iconPath}: invalid ICO header`);
  const count = icon.readUInt16LE(4);
  assert(count > 0 && icon.length >= 6 + count * 16, `${iconPath}: invalid ICO directory`);

  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    const byteLength = icon.readUInt32LE(entryOffset + 8);
    const imageOffset = icon.readUInt32LE(entryOffset + 12);
    assert(byteLength > 0, `${iconPath}: ICO image ${index} is empty`);
    assert(imageOffset + byteLength <= icon.length, `${iconPath}: ICO image ${index} extends beyond the file`);
  }
} else {
  throw new Error(`${iconPath}: Windows icon must be PNG or ICO`);
}

assert(
  electronMain.includes("path.join(__dirname, '../dist/pwa-512x512.png')"),
  'Electron BrowserWindow must use the packaged ZAIPOS PNG icon',
);
assert(!electronMain.includes('favicon.ico'), 'Electron runtime must not reference the malformed legacy ICO');
assert(!viteConfig.includes('"favicon.ico"'), 'PWA precache must not retain the malformed legacy ICO');

console.log(`Windows icon contract PASS: ${iconPath}`);
