/**
 * electron/main.ts
 * Electron main process for ZAIPOS.
 *
 * Responsibilities:
 * - Create and manage the main BrowserWindow
 * - Register hardware IPC handlers
 * - Manage kiosk mode
 * - Manage persistent app configuration with electron-store
 * - Initialize the auto-updater
 */

import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppSettings } from './types.js';
import { DEFAULT_SETTINGS, IPC_HANDLERS } from './types.js';
import { setupPrinterHandlers } from './services/printer.js';
import { setupBarcodeScanner, closeBarcodeScanner, restartBarcodeScanner } from './services/barcode.js';
import { setupUpdater } from './services/updater.js';
import { log } from './logger.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Electron Store (persistent configuration) ────────────────────────────────

// Keep the existing store name for backward compatibility with installed devices.
let store: any = null;

async function initStore(): Promise<void> {
  const { default: ElectronStore } = await import('electron-store');
  store = new ElectronStore({
    name: 'pos-settings',
    defaults: DEFAULT_SETTINGS,
  });
}

function getSettings(): AppSettings {
  return store ? (store.store as AppSettings) : DEFAULT_SETTINGS;
}

// ─── Main Window ──────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

function createWindow(settings: AppSettings): BrowserWindow {
  const { kiosk } = settings;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    // Kiosk mode: frameless and forced fullscreen.
    kiosk,
    frame: !kiosk,
    fullscreen: kiosk,
    titleBarStyle: kiosk ? 'hidden' : 'default',
    backgroundColor: '#0f0f0f',
    show: false,
    icon: path.join(__dirname, '../public/favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (!kiosk && process.env.NODE_ENV === 'development') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    const appUrl = process.env.VITE_DEV_SERVER_URL ?? `file://${path.join(__dirname, '../dist/index.html')}`;
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      if (!kiosk) shell.openExternal(url);
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

// ─── Global IPC Handlers ──────────────────────────────────────────────────────

function setupGlobalHandlers(): void {
  ipcMain.handle(IPC_HANDLERS.GET_SETTINGS, async () => {
    return getSettings();
  });

  ipcMain.handle(IPC_HANDLERS.SAVE_SETTINGS, async (_event, newSettings: Partial<AppSettings>) => {
    if (!store) return;
    const current = getSettings();
    const merged = { ...current, ...newSettings };

    if (newSettings.printer) merged.printer = { ...current.printer, ...newSettings.printer };
    if (newSettings.barcode) merged.barcode = { ...current.barcode, ...newSettings.barcode };

    store.set(merged);

    if (newSettings.barcode && mainWindow) {
      await restartBarcodeScanner(merged.barcode, mainWindow);
    }
  });

  ipcMain.handle(IPC_HANDLERS.SET_KIOSK, async (_event, enabled: boolean) => {
    if (!mainWindow) return;

    store?.set('kiosk', enabled);
    mainWindow.setKiosk(enabled);
    mainWindow.setFullScreen(enabled);
    mainWindow.setMenuBarVisibility(!enabled);

    log("info", "kiosk_mode_updated", { enabled });
  });

  ipcMain.handle(IPC_HANDLERS.OPEN_EXTERNAL, async (_event, url: string) => {
    if (/^https?:\/\/.+/.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC_HANDLERS.GET_APP_VERSION, () => {
    return app.getVersion();
  });

  log("info", "ipc_handlers_registered");
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  await initStore();
  const settings = getSettings();
  log("info", "settings_loaded", { kiosk: settings.kiosk, printer: settings.printer, barcode: settings.barcode });

  setupGlobalHandlers();
  setupPrinterHandlers(() => getSettings().printer);
  mainWindow = createWindow(settings);

  mainWindow.once('ready-to-show', async () => {
    if (mainWindow) {
      await setupBarcodeScanner(settings.barcode, mainWindow);
    }
  });

  if (mainWindow) {
    await setupUpdater(mainWindow);
  }

  mainWindow.on('closed', () => {
    closeBarcodeScanner();
    mainWindow = null;
  });
}

// ─── Electron Lifecycle ───────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log("error", "single_instance_lock_failed");
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(bootstrap).catch((err) => {
  log("error", "bootstrap_failed", { error: err?.message ?? String(err) });
  dialog.showErrorBox(
    'Error starting ZAIPOS',
    `Unexpected error: ${err?.message ?? err}`
  );
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && store) {
    mainWindow = createWindow(getSettings());
  }
});

app.on('before-quit', () => {
  closeBarcodeScanner();
});
