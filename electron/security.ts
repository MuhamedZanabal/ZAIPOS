import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

let trustedWindow: BrowserWindow | null = null;
let trustedAppUrl = '';
const hasUnsafeWhitespace = (value: string) => Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);

export function isTrustedAppUrl(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || hasUnsafeWhitespace(candidate)) return false;
  try {
    const actual = new URL(candidate);
    const app = new URL(expected);
    if (actual.username || actual.password || actual.protocol !== app.protocol) return false;
    if (app.protocol === 'file:') return actual.hostname === app.hostname && actual.pathname === app.pathname;
    return ['http:', 'https:'].includes(app.protocol) && actual.origin === app.origin;
  } catch { return false; }
}

export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || hasUnsafeWhitespace(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function configureTrustedWindow(window: BrowserWindow, appUrl: string): void {
  trustedWindow = window;
  trustedAppUrl = appUrl;
  const contents = window.webContents;
  const blockNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!isTrustedAppUrl(url, appUrl)) event.preventDefault();
  };
  contents.on('will-navigate', blockNavigation);
  contents.on('will-redirect', blockNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const window = trustedWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() ||
      event.sender !== window.webContents || !event.senderFrame ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedAppUrl(event.senderFrame.url, trustedAppUrl)) {
    throw new Error('Untrusted desktop IPC sender');
  }
}

/** All renderer-triggered native effects must register through this boundary. */
export function handleTrustedIpc(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}
