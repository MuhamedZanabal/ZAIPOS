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

import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { configureTrustedWindow, handleTrustedIpc, safeExternalUrl } from './security.js';
import type { AppSettings } from './types.js';
import { DEFAULT_SETTINGS, IPC_HANDLERS } from './types.js';
import { setupPrinterHandlers } from './services/printer.js';
import { setupBarcodeScanner, closeBarcodeScanner, restartBarcodeScanner } from './services/barcode.js';
import { setupUpdater } from './services/updater.js';
import { validateSettings, validateSettingsPatch } from './hardware-security.js';
import { handleManagerIpc } from './manager-authorization.js';
import { log } from './logger.js';
import { createDeviceCredentialService } from './services/device-credentials.js';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Electron Store (persistent configuration) ────────────────────────────────

// Keep the existing store name for backward compatibility with installed devices.
let store: any = null;
let credentialStore: any = null;

async function initStore(): Promise<void> {
  const { default: ElectronStore } = await import('electron-store');
  store = new ElectronStore({
    name: 'pos-settings',
    defaults: DEFAULT_SETTINGS,
  });
  credentialStore = new ElectronStore({ name: 'device-credentials' });
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
    icon: path.join(__dirname, '../dist/pwa-512x512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      sandbox: true,
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

  const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  const appUrl = devUrl ?? pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  configureTrustedWindow(win, appUrl);
  if (devUrl) {
    const parsed = new URL(devUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Desktop development server must use an explicit loopback origin');
    }
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

// ─── Global IPC Handlers ──────────────────────────────────────────────────────

function setupGlobalHandlers(): void {
  const deviceCredentials = createDeviceCredentialService(
    credentialStore,
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  );
  handleTrustedIpc(IPC_HANDLERS.GET_DEVICE_IDENTITY, () => deviceCredentials.identity());
  handleTrustedIpc(IPC_HANDLERS.ACTIVATE_DEVICE, (_event, approvalId, authorization) =>
    deviceCredentials.activate(approvalId, app.getVersion(), process.platform, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_CHECKOUT, (_event, payload, authorization) =>
    deviceCredentials.checkout(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.GET_SETTINGS, async () => {
    return getSettings();
  });

  handleManagerIpc(IPC_HANDLERS.SAVE_SETTINGS, 'settings', async (_event, newSettings: Partial<AppSettings>) => {
    validateSettingsPatch(newSettings);
    if (!store) throw new Error('Settings are unavailable');
    const current = getSettings();
    const merged = { ...current, ...newSettings };

    if (newSettings.printer) merged.printer = { ...current.printer, ...newSettings.printer };
    if (newSettings.barcode) merged.barcode = { ...current.barcode, ...newSettings.barcode };

    const validated = validateSettings(merged);
    store.set(validated);

    if (newSettings.barcode && mainWindow) {
      await restartBarcodeScanner(validated.barcode, mainWindow);
    }
  });

  handleManagerIpc(IPC_HANDLERS.SET_KIOSK, 'kiosk', async (_event, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Invalid kiosk setting');
    if (!mainWindow) return;

    store?.set('kiosk', enabled);
    mainWindow.setKiosk(enabled);
    mainWindow.setFullScreen(enabled);
    mainWindow.setMenuBarVisibility(!enabled);

    log("info", "kiosk_mode_updated", { enabled });
  });

  handleTrustedIpc(IPC_HANDLERS.OPEN_EXTERNAL, async (_event, url: string) => {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) throw new Error("External URL is not allowed");
    await shell.openExternal(safeUrl);
  });

  handleTrustedIpc(IPC_HANDLERS.GET_APP_VERSION, () => {
    return app.getVersion();
  });

  log("info", "ipc_handlers_registered");
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  await initStore();
  const settings = getSettings();
  log("info", "settings_loaded", { kiosk: settings.kiosk, printerType: settings.printer?.connectionType, barcodeMode: settings.barcode?.mode });

  setupGlobalHandlers();
  setupPrinterHandlers(() => getSettings().printer);
  mainWindow = createWindow(settings);

  mainWindow.once('ready-to-show', async () => {
    if (mainWindow) {
      await setupBarcodeScanner(settings.barcode, mainWindow);
    }
  });

  if (mainWindow) {
    await setupUpdater(mainWindow, settings.updateChannel);
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
