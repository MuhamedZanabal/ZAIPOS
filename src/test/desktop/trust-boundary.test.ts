import { describe, expect, it, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => state.handlers.set(name, fn) } }));
import { configureTrustedWindow, handleTrustedIpc, isTrustedAppUrl, safeExternalUrl } from '../../../electron/security';

const appUrl = 'file:///C:/Program%20Files/ZAIPOS/dist/index.html';
describe('desktop trust boundary', () => {
  beforeEach(() => { state.handlers.clear(); });
  it('permits only the exact packaged document with SPA fragments', () => {
    expect(isTrustedAppUrl(`${appUrl}#/pos`, appUrl)).toBe(true);
    for (const url of [`${appUrl}.evil`, 'file:///C:/secrets.txt', 'https://evil.test/', 'javascript:alert(1)', 'about:blank', 'not a URL']) {
      expect(isTrustedAppUrl(url, appUrl)).toBe(false);
    }
  });
  it('compares development origins structurally, rejecting prefix lookalikes', () => {
    expect(isTrustedAppUrl('http://localhost:8080/pos', 'http://localhost:8080')).toBe(true);
    for (const url of ['http://localhost:8080.evil.test', 'http://localhost:8081', 'http://localhost:8080@evil.test', 'https://localhost:8080']) {
      expect(isTrustedAppUrl(url, 'http://localhost:8080')).toBe(false);
    }
  });
  it('never sends OS schemes, credentials or control characters to openExternal', () => {
    expect(safeExternalUrl('https://example.com/docs')).toBe('https://example.com/docs');
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'javascript:1', 'data:text/html,x', 'https://user:password@example.com', 'https://good.test\nevil', ' https://example.com', 42, null]) {
      expect(safeExternalUrl(url)).toBeNull();
    }
  });
  it('rejects iframe, foreign window, missing frame and navigated sender before invoking privileged effects', async () => {
    const frame = { url: appUrl };
    const webContents = { mainFrame: frame, isDestroyed: () => false, on: vi.fn(), setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } };
    const window = { webContents, isDestroyed: () => false };
    configureTrustedWindow(window as any, appUrl);
    const effect = vi.fn(() => 'allowed');
    handleTrustedIpc('test', effect);
    const invoke = state.handlers.get('test')!;
    expect(await invoke({ sender: webContents, senderFrame: frame }, 'payload')).toBe('allowed');
    effect.mockClear();
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: webContents, senderFrame: { url: appUrl } },
      { sender: webContents, senderFrame: null },
    ]) await expect(invoke(event)).rejects.toThrow(/untrusted/i);
    frame.url = 'https://evil.test';
    await expect(invoke({ sender: webContents, senderFrame: frame })).rejects.toThrow(/untrusted/i);
    expect(effect).not.toHaveBeenCalled();
  });
  it('denies new windows, untrusted navigation, redirects and webview attachment', () => {
    const events = new Map<string, (...args: any[]) => any>();
    const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    const contents = { on: (event: string, callback: any) => events.set(event, callback), setWindowOpenHandler: vi.fn(), session };
    configureTrustedWindow({ webContents: contents } as any, appUrl);
    expect(contents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://evil.test' })).toEqual({ action: 'deny' });
    for (const event of ['will-navigate', 'will-redirect']) {
      const preventDefault = vi.fn();
      events.get(event)!({ preventDefault }, 'file:///C:/untrusted.html');
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    const preventDefault = vi.fn();
    events.get('will-attach-webview')!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    const callback = vi.fn();
    session.setPermissionRequestHandler.mock.calls[0][0](contents, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });
});
