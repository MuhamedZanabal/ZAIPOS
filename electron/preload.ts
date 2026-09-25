/** Secure renderer bridge for explicitly allowed Electron operations. */
import { contextBridge, ipcRenderer } from 'electron';
import type { TicketData, AppSettings, BackendConfig, ManagerAuthorization } from './types.js';
import { IPC_EVENTS, IPC_HANDLERS } from './types.js';

const electronAPI = {
  printTicket: (data: TicketData) => ipcRenderer.invoke(IPC_HANDLERS.PRINT_TICKET, data),
  openDrawer: () => ipcRenderer.invoke(IPC_HANDLERS.OPEN_DRAWER),
  onBarcodeScanned: (callback: (code: string) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, code: string) => callback(code); ipcRenderer.on(IPC_EVENTS.BARCODE_SCANNED, handler); return () => ipcRenderer.removeListener(IPC_EVENTS.BARCODE_SCANNED, handler); },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC_HANDLERS.GET_SETTINGS),
  saveSettings: (settings: Partial<AppSettings>, authorization: ManagerAuthorization): Promise<void> => ipcRenderer.invoke(IPC_HANDLERS.SAVE_SETTINGS, settings, authorization),
  setKiosk: (enabled: boolean, authorization: ManagerAuthorization): Promise<void> => ipcRenderer.invoke(IPC_HANDLERS.SET_KIOSK, enabled, authorization),
  downloadUpdate: (authorization: ManagerAuthorization) => ipcRenderer.invoke(IPC_HANDLERS.DOWNLOAD_UPDATE, null, authorization),
  installUpdate: (authorization: ManagerAuthorization) => ipcRenderer.invoke(IPC_HANDLERS.INSTALL_UPDATE, null, authorization),
  onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: string }) => void): (() => void) => { const handler = (_: any, info: any) => callback(info); ipcRenderer.on(IPC_EVENTS.UPDATE_AVAILABLE, handler); return () => ipcRenderer.removeListener(IPC_EVENTS.UPDATE_AVAILABLE, handler); },
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number }) => void): (() => void) => { const handler = (_: any, progress: any) => callback(progress); ipcRenderer.on(IPC_EVENTS.DOWNLOAD_PROGRESS, handler); return () => ipcRenderer.removeListener(IPC_EVENTS.DOWNLOAD_PROGRESS, handler); },
  onUpdateDownloaded: (callback: (info: { version: string }) => void): (() => void) => { const handler = (_: any, info: any) => callback(info); ipcRenderer.on(IPC_EVENTS.UPDATE_DOWNLOADED, handler); return () => ipcRenderer.removeListener(IPC_EVENTS.UPDATE_DOWNLOADED, handler); },
  openExternal: (url: string) => ipcRenderer.invoke(IPC_HANDLERS.OPEN_EXTERNAL, url),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.GET_APP_VERSION),
  getBackendConfig: (): Promise<BackendConfig | null> => ipcRenderer.invoke(IPC_HANDLERS.GET_BACKEND_CONFIG),
  saveInitialBackendConfig: (config: BackendConfig): Promise<void> => ipcRenderer.invoke(IPC_HANDLERS.SAVE_INITIAL_BACKEND_CONFIG, config),
  getDeviceIdentity: (): Promise<{ deviceUid: string; provisioned: boolean }> => ipcRenderer.invoke(IPC_HANDLERS.GET_DEVICE_IDENTITY),
  activateDevice: (approvalId: string, authorization: ManagerAuthorization) => ipcRenderer.invoke(IPC_HANDLERS.ACTIVATE_DEVICE, approvalId, authorization),
  rotateDeviceCredential: (approvalId: string, authorization: ManagerAuthorization): Promise<{ deviceUid: string; provisioned: true }> => ipcRenderer.invoke(IPC_HANDLERS.ROTATE_DEVICE_CREDENTIAL, approvalId, authorization),
  revokeDevice: (deviceId: string, authorization: ManagerAuthorization): Promise<{ deviceUid: string; provisioned: false; revoked: boolean }> => ipcRenderer.invoke(IPC_HANDLERS.REVOKE_DEVICE, deviceId, authorization),
  checkoutSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string | { status: 'pending'; mutationId: string }> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_CHECKOUT, payload, authorization),
  cashMovement: (payload: Record<string, unknown>, authorization: ManagerAuthorization, cancel = false): Promise<string | null> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_CASH_MOVEMENT, payload, authorization, cancel),
  cashSession: (payload: Record<string, unknown>, authorization: ManagerAuthorization, close = false): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_CASH_SESSION, payload, authorization, close),
  returnSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_SALE_RETURN, payload, authorization),
  voidSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_SALE_VOID, payload, authorization),
  collectDeliveryPayment: (payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_DELIVERY_COLLECTION, payload, authorization),
  checkoutTableOrder: (payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_TABLE_CHECKOUT, payload, authorization),
  inventoryCommand: (command: string, payload: Record<string, unknown>, authorization: ManagerAuthorization): Promise<string> => ipcRenderer.invoke(IPC_HANDLERS.DEVICE_INVENTORY_COMMAND, command, payload, authorization),
  platform: process.platform as NodeJS.Platform,
  localStatus: () => ipcRenderer.invoke(IPC_HANDLERS.LOCAL_STATUS),
  enrollLocalTerminal: () => ipcRenderer.invoke(IPC_HANDLERS.LOCAL_ENROLL),
  localRequest: (path: string) => ipcRenderer.invoke(IPC_HANDLERS.LOCAL_REQUEST, path),
  subscribeLocalEvents: (callback: (payload: { state: 'not_configured' }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { state: 'not_configured' }) => callback(payload);
    ipcRenderer.on(IPC_EVENTS.LOCAL_SERVICE_EVENT, handler);
    void ipcRenderer.invoke(IPC_HANDLERS.LOCAL_SUBSCRIBE).catch(() => undefined);
    return () => ipcRenderer.removeListener(IPC_EVENTS.LOCAL_SERVICE_EVENT, handler);
  },
};
contextBridge.exposeInMainWorld('electron', electronAPI);
export type ElectronAPI = typeof electronAPI;
