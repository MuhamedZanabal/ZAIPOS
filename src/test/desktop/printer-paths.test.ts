import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ constructed: vi.fn(), execute: vi.fn(async () => true) }));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('node-thermal-printer', () => ({
  ThermalPrinter: class { constructor(config: unknown) { native.constructed(config); } raw() {} execute = native.execute; },
  PrinterTypes: { EPSON: 'epson' }, CharacterSet: { SLOVENIA: 'slovenia' },
}));
import { openCashDrawer } from '../../../electron/services/printer';
describe('native printer destination authority', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each(['/tmp/zaipos-sentinel.txt','../settings.json','tcp://127.0.0.1:22','printer:unapproved'])('rejects arbitrary file/protocol destination %s before native construction', async (devicePath) => {
    expect((await openCashDrawer({ connectionType: 'usb', devicePath })).ok).toBe(false);
    expect(native.constructed).not.toHaveBeenCalled();
    expect(native.execute).not.toHaveBeenCalled();
  });
  it('does not treat an unimplemented Bluetooth address as a file', async () => {
    expect((await openCashDrawer({ connectionType: 'bluetooth', bluetoothAddress: 'AA:BB:CC:DD:EE:FF' })).ok).toBe(false);
    expect(native.constructed).not.toHaveBeenCalled();
  });
});

import { validatePrinterConfig, validateSettings, validateBarcodeConfig, validateTicket } from '../../../electron/hardware-security';
it('allows an explicit private raw-printer endpoint', async () => {
  native.constructed.mockClear();
  expect((await openCashDrawer({ connectionType: 'network', host: '192.168.1.40', port: 9100 })).ok).toBe(true);
  expect(native.constructed).toHaveBeenCalledWith(expect.objectContaining({ interface: 'tcp://192.168.1.40:9100' }));
});
it.each(['127.0.0.1','169.254.169.254','8.8.8.8','192.168.1.1/../../x','user@192.168.1.1','printer.local'])('rejects unapproved network host %s', (host) => {
  expect(() => validatePrinterConfig({ connectionType: 'network', host })).toThrow();
});
it('rejects protocol-port substitution and invalid geometry', () => {
  expect(() => validatePrinterConfig({ connectionType: 'network', host: '10.0.0.2', port: 22 })).toThrow();
  expect(() => validatePrinterConfig({ connectionType: 'network', host: '10.0.0.2', width: 1e9 })).toThrow();
  expect(() => validateBarcodeConfig({mode: 'serial', serialPort: '/tmp/secrets'})).toThrow();
});
it('rejects unknown persistence keys and executable receipt control sequences', () => {
  expect(() => validateSettings({ kiosk: false, updateChannel:'stable', injected: true })).toThrow();
  expect(() => validateTicket({items:[],payments:[],notes:'receipt\x1bp\0'})).toThrow();
  expect(() => validateTicket({items:[],payments:[],total:Infinity})).toThrow();
});
