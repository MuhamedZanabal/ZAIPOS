/**
 * electron/main.ts
 * Electron main process for ZAIPOS.
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
import { createDeviceOfflineAuthority } from './services/device-offline-authority.js';
import { createDeviceOfflineQueue } from './services/device-offline-queue.js';
import { createDeviceOfflineOrchestrator } from './services/device-offline-orchestrator.js';
import { createDeviceCheckoutCoordinator } from './services/device-checkout-coordinator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let store: any = null;
let credentialStore: any = null;
async function initStore(): Promise<void> { const { default: ElectronStore } = await import('electron-store'); store = new ElectronStore({ name: 'pos-settings', defaults: DEFAULT_SETTINGS }); credentialStore = new ElectronStore({ name: 'device-credentials' }); }
function getSettings(): AppSettings { return store ? (store.store as AppSettings) : DEFAULT_SETTINGS; }
let mainWindow: BrowserWindow | null = null;

function createWindow(settings: AppSettings): BrowserWindow {
  const { kiosk } = settings;
  const win = new BrowserWindow({ width: 1280, height: 800, minWidth: 1024, minHeight: 600, kiosk, frame: !kiosk, fullscreen: kiosk, titleBarStyle: kiosk ? 'hidden' : 'default', backgroundColor: '#0f0f0f', show: false, icon: path.join(__dirname, '../dist/pwa-512x512.png'), webPreferences: { preload: path.join(__dirname, 'preload.mjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
  win.once('ready-to-show', () => { win.show(); if (!kiosk && process.env.NODE_ENV === 'development') win.webContents.openDevTools({ mode: 'detach' }); });
  const devUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  const appUrl = devUrl ?? pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  configureTrustedWindow(win, appUrl);
  if (devUrl) { const parsed = new URL(devUrl); if (!['http:', 'https:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Desktop development server must use an explicit loopback origin'); win.loadURL(devUrl); } else win.loadFile(path.join(__dirname, '../dist/index.html'));
  return win;
}

function setupGlobalHandlers(): void {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const deviceCredentials = createDeviceCredentialService(credentialStore, supabaseUrl, publishableKey);
  const offlineAuthority = createDeviceOfflineAuthority(credentialStore, supabaseUrl, publishableKey);
  // Recovery runs in Electron main before any renderer can request financial work.
  // No queue or lease-capability IPC exists while offline checkout remains gated.
  const offlineQueue = createDeviceOfflineQueue(credentialStore, offlineAuthority, supabaseUrl, publishableKey);
  const offlineOrchestrator = createDeviceOfflineOrchestrator(offlineQueue, { enabled: false });
  const recoveredOfflineQueue = offlineQueue.recover();
  const recoverySnapshot = offlineOrchestrator.recovery().map(({ mutationId, state }) => ({ mutationId, state }));
  log('info', 'device_offline_queue_recovered', {
    pendingCount: recoveredOfflineQueue.records.length,
    quarantinedCount: offlineQueue.quarantined().length,
    confirmedCount: offlineQueue.confirmed().length,
    checkoutEnabled: offlineOrchestrator.enabled,
    recovery: recoverySnapshot,
  });
  const refreshOfflineAuthority = async (authorization: any): Promise<void> => {
    try {
      const lease = await offlineAuthority.refresh(authorization);
      log('info', 'device_offline_authority_refreshed', { leaseId: lease.leaseId, expiresAt: lease.expiresAt });
    } catch (error: any) {
      offlineAuthority.clear();
      log('warn', 'device_offline_authority_unavailable', { error: error?.message ?? String(error) });
    }
  };
  const checkoutCoordinator = createDeviceCheckoutCoordinator({
    checkout: (payload, authorization) => deviceCredentials.checkout(payload as any, authorization),
    readActive: offlineAuthority.readActive,
    refresh: offlineAuthority.refresh,
    orchestrator: offlineOrchestrator,
    report: (summary) => log('info', 'device_offline_queue_drained', summary),
    reportFailure: (error) => log('warn', 'device_offline_queue_drain_failed', { error }),
  });
  handleTrustedIpc(IPC_HANDLERS.GET_DEVICE_IDENTITY, () => deviceCredentials.identity());
  handleTrustedIpc(IPC_HANDLERS.ACTIVATE_DEVICE, async (_event, approvalId, authorization) => { const result = await deviceCredentials.activate(approvalId, app.getVersion(), process.platform, authorization); await refreshOfflineAuthority(authorization); return result; });
  handleTrustedIpc(IPC_HANDLERS.ROTATE_DEVICE_CREDENTIAL, async (_event, approvalId, authorization) => { offlineAuthority.clear(); const result = await deviceCredentials.rotate(approvalId, authorization); await refreshOfflineAuthority(authorization); return result; });
  handleTrustedIpc(IPC_HANDLERS.REVOKE_DEVICE, async (_event, deviceId, authorization) => { const result = await deviceCredentials.revoke(deviceId, authorization); offlineAuthority.clear(); return result; });
  handleTrustedIpc(IPC_HANDLERS.DEVICE_CHECKOUT, (_event, payload, authorization) => checkoutCoordinator.checkout(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_CASH_MOVEMENT, (_event, payload, authorization, cancel) => deviceCredentials.cashMovement(payload, authorization, cancel));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_CASH_SESSION, (_event, payload, authorization, close) => deviceCredentials.cashSession(payload, authorization, close));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_SALE_RETURN, (_event, payload, authorization) => deviceCredentials.returnSale(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_SALE_VOID, (_event, payload, authorization) => deviceCredentials.voidSale(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_DELIVERY_COLLECTION, (_event, payload, authorization) => deviceCredentials.collectDeliveryPayment(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_TABLE_CHECKOUT, (_event, payload, authorization) => deviceCredentials.checkoutTableOrder(payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.DEVICE_INVENTORY_COMMAND, (_event, command, payload, authorization) => deviceCredentials.inventoryCommand(command, payload, authorization));
  handleTrustedIpc(IPC_HANDLERS.GET_SETTINGS, async () => getSettings());
  handleManagerIpc(IPC_HANDLERS.SAVE_SETTINGS, 'settings', async (_event, newSettings: Partial<AppSettings>) => { validateSettingsPatch(newSettings); if (!store) throw new Error('Settings are unavailable'); const current = getSettings(); const merged = { ...current, ...newSettings }; if (newSettings.printer) merged.printer = { ...current.printer, ...newSettings.printer }; if (newSettings.barcode) merged.barcode = { ...current.barcode, ...newSettings.barcode }; const validated = validateSettings(merged); store.set(validated); if (newSettings.barcode && mainWindow) await restartBarcodeScanner(validated.barcode, mainWindow); });
  handleManagerIpc(IPC_HANDLERS.SET_KIOSK, 'kiosk', async (_event, enabled: boolean) => { if (typeof enabled !== 'boolean') throw new Error('Invalid kiosk setting'); if (!mainWindow) return; store?.set('kiosk', enabled); mainWindow.setKiosk(enabled); mainWindow.setFullScreen(enabled); mainWindow.setMenuBarVisibility(!enabled); log('info', 'kiosk_mode_updated', { enabled }); });
  handleTrustedIpc(IPC_HANDLERS.OPEN_EXTERNAL, async (_event, url: string) => { const safeUrl = safeExternalUrl(url); if (!safeUrl) throw new Error('External URL is not allowed'); await shell.openExternal(safeUrl); });
  handleTrustedIpc(IPC_HANDLERS.GET_APP_VERSION, () => app.getVersion());
  log('info', 'ipc_handlers_registered');
}

async function bootstrap(): Promise<void> { await initStore(); const settings = getSettings(); log('info', 'settings_loaded', { kiosk: settings.kiosk, printerType: settings.printer?.connectionType, barcodeMode: settings.barcode?.mode }); setupGlobalHandlers(); setupPrinterHandlers(() => getSettings().printer); mainWindow = createWindow(settings); mainWindow.once('ready-to-show', async () => { if (mainWindow) await setupBarcodeScanner(settings.barcode, mainWindow); }); if (mainWindow) await setupUpdater(mainWindow, settings.updateChannel); mainWindow.on('closed', () => { closeBarcodeScanner(); mainWindow = null; }); }
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { log('error', 'single_instance_lock_failed'); app.quit(); } else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.whenReady().then(bootstrap).catch((err) => { log('error', 'bootstrap_failed', { error: err?.message ?? String(err) }); dialog.showErrorBox('Error starting ZAIPOS', `Unexpected error: ${err?.message ?? err}`); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && store) mainWindow = createWindow(getSettings()); });
app.on('before-quit', () => { closeBarcodeScanner(); });
