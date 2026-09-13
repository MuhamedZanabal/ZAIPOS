import { lstatSync } from 'node:fs';
import { isIP } from 'node:net';
import type { AppSettings, BarcodeConfig, PrinterConfig, TicketData } from './types.js';

function record(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hardware configuration');
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown hardware setting');
  return value as Record<string, any>;
}
function boundedInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid hardware numeric setting');
  return value;
}
function deviceName(value: unknown, kind: 'printer' | 'serial'): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid hardware device path');
  if (process.platform === 'win32') {
    const name = value.startsWith('\\\\.\\') ? value.slice(4) : value;
    if (/^COM[1-9]\d{0,2}$/.test(name)) return `\\\\.\\${name}`;
  } else if (kind === 'printer' && /^\/dev\/usb\/lp\d{1,3}$/.test(value)) return value;
  else if (kind === 'serial' && /^\/dev\/(?:tty(?:USB|ACM)\d{1,3}|cu\.[A-Za-z0-9_-]{1,100})$/.test(value)) return value;
  throw new Error('Unsupported hardware device path');
}
export function validatePrinterConfig(value: unknown): PrinterConfig {
  const c = record(value, ['connectionType','devicePath','host','port','bluetoothAddress','width','characterSet']);
  if (c.connectionType !== 'usb' && c.connectionType !== 'network') throw new Error('Unsupported printer connection; Bluetooth requires a reviewed transport');
  const result: PrinterConfig = { connectionType: c.connectionType, width: boundedInteger(c.width ?? 42, 16, 80) };
  if (c.characterSet !== undefined && (typeof c.characterSet !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(c.characterSet))) throw new Error('Invalid printer character set');
  result.characterSet = c.characterSet ?? 'SLOVENIA';
  if (c.connectionType === 'usb') result.devicePath = deviceName(c.devicePath, 'printer');
  else {
    if (typeof c.host !== 'string' || isIP(c.host) !== 4) throw new Error('Printer requires an explicit private IPv4 address');
    const [a,b] = c.host.split('.').map(Number);
    if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw new Error('Printer address must be on a private store network');
    result.host = c.host;
    result.port = boundedInteger(c.port ?? 9100, 9100, 9109);
  }
  return result;
}
export function printerInterface(value: unknown): string {
  const c = validatePrinterConfig(value);
  if (c.connectionType === 'network') return `tcp://${c.host}:${c.port}`;
  if (process.platform !== 'win32') {
    const stat = lstatSync(c.devicePath!);
    if (stat.isSymbolicLink() || !stat.isCharacterDevice()) throw new Error('Printer destination must be a character device');
  }
  return c.devicePath!;
}
export function validateBarcodeConfig(value: unknown): BarcodeConfig {
  const c = record(value, ['mode','serialPort','baudRate']);
  if (!['hid','serial'].includes(c.mode)) throw new Error('Invalid barcode mode');
  const result: BarcodeConfig = { mode: c.mode, baudRate: boundedInteger(c.baudRate ?? 9600, 300, 115200) };
  if (c.mode === 'serial') result.serialPort = deviceName(c.serialPort, 'serial');
  return result;
}
export function validateSettings(value: unknown): AppSettings {
  const s = record(value, ['kiosk','updateChannel','printer','barcode']);
  if (typeof s.kiosk !== 'boolean' || !['stable','beta'].includes(s.updateChannel)) throw new Error('Invalid application setting');
  return { kiosk: s.kiosk, updateChannel: s.updateChannel, printer: validatePrinterConfig(s.printer), barcode: validateBarcodeConfig(s.barcode) };
}
export function validateSettingsPatch(value: unknown): void {
  record(value, ['kiosk','updateChannel','printer','barcode']);
}
export function validateTicket(value: unknown): asserts value is TicketData {
  if (!value || typeof value !== 'object') throw new Error('Invalid receipt payload');
  const ticket = value as TicketData;
  if (!Array.isArray(ticket.items) || ticket.items.length > 1000 || !Array.isArray(ticket.payments) || ticket.payments.length > 100) throw new Error('Receipt exceeds supported size');
  const serialized = JSON.stringify(ticket);
  if (serialized.length > 262144) throw new Error('Receipt exceeds supported size');
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 8) throw new Error('Invalid receipt nesting');
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)) throw new Error('Invalid receipt number');
    if (typeof v === 'string' && (v.length > 8192 || Array.from(v).some((c) => (c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t') || c.charCodeAt(0) === 127))) throw new Error('Receipt contains unsupported control data');
    if (v && typeof v === 'object') Object.values(v).forEach((entry) => visit(entry, depth + 1));
  };
  visit(ticket);
}
