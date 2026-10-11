import { BrowserWindow, screen } from 'electron';
import { pathToFileURL } from 'node:url';

/**
 * Second, customer-facing window (ticket + total, bilingual). It gets NO
 * preload script, so it has no desktop bridge and cannot reach any IPC
 * handler; it only reads the ticket the register mirrors into localStorage.
 * ZAIPOS_CUSTOMER_DISPLAY: unset/"auto" = open when a second screen exists,
 * "1" = always (windowed, for testing), "0" = never.
 */
export function customerDisplayMode(env = process.env.ZAIPOS_CUSTOMER_DISPLAY): 'auto' | 'on' | 'off' {
  if (env === '1' || env === 'on') return 'on';
  if (env === '0' || env === 'off') return 'off';
  return 'auto';
}

/** Route URL for the display: hash route for packaged file:// builds, path route for the dev server. */
export function customerDisplayUrl(appIndexPath: string, devUrl?: string): string {
  if (devUrl) return new URL('/customer-display', devUrl).href;
  return `${pathToFileURL(appIndexPath).href}#/customer-display`;
}

let displayWindow: BrowserWindow | null = null;

export function openCustomerDisplay(appIndexPath: string, devUrl?: string): BrowserWindow | null {
  const mode = customerDisplayMode();
  if (mode === 'off' || (displayWindow && !displayWindow.isDestroyed())) return displayWindow;
  const primary = screen.getPrimaryDisplay();
  const external = screen.getAllDisplays().find((d) => d.id !== primary.id);
  if (!external && mode === 'auto') return null;
  const bounds = external?.bounds ?? { x: primary.bounds.x + 40, y: primary.bounds.y + 40, width: 1024, height: 600 };
  const win = new BrowserWindow({
    ...bounds,
    fullscreen: !!external,
    frame: !external,
    title: 'ZAIPOS — Customer display',
    backgroundColor: '#0f0f0f',
    focusable: !external,
    skipTaskbar: !!external,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false },
  });
  const url = customerDisplayUrl(appIndexPath, devUrl);
  const allowed = (target: string) => target.split('#')[0] === url.split('#')[0];
  const block = (event: { preventDefault(): void }, target: string) => { if (!allowed(target)) event.preventDefault(); };
  win.webContents.on('will-navigate', block);
  win.webContents.on('will-redirect', block);
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.setMenuBarVisibility(false);
  win.on('closed', () => { displayWindow = null; });
  void win.loadURL(url);
  displayWindow = win;
  return win;
}
