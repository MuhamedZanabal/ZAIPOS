import type { ManagerAuthorization } from '../../electron/types';
import type { TicketData, AppSettings, BackendConfig } from '../../electron/types';

export interface ElectronBridge {
  printTicket: (data: TicketData) => Promise<{ ok: boolean; error?: string }>;
  openDrawer: () => Promise<{ ok: boolean; error?: string }>;
  onBarcodeScanned: (callback: (code: string) => void) => () => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>, authorization: ManagerAuthorization) => Promise<void>;
  setKiosk: (enabled: boolean, authorization: ManagerAuthorization) => Promise<void>;
  downloadUpdate: (authorization: ManagerAuthorization) => Promise<{ ok: boolean; error?: string }>;
  installUpdate: (authorization: ManagerAuthorization) => Promise<void>;
  onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: string }) => void) => () => void;
  onDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  getAppVersion: () => Promise<string>;
  getBackendConfig: () => Promise<BackendConfig | null>;
  saveInitialBackendConfig: (config: BackendConfig) => Promise<void>;
  getDeviceIdentity: () => Promise<{ deviceUid: string; provisioned: boolean }>;
  activateDevice: (approvalId: string, authorization: ManagerAuthorization) => Promise<{ deviceUid: string; provisioned: true }>;
  rotateDeviceCredential: (approvalId: string, authorization: ManagerAuthorization) => Promise<{ deviceUid: string; provisioned: true }>;
  revokeDevice: (deviceId: string, authorization: ManagerAuthorization) => Promise<{ deviceUid: string; provisioned: false; revoked: boolean }>;
  checkoutSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string | { status: 'pending'; mutationId: string }>;
  cashMovement: (payload: Record<string, unknown>, authorization: ManagerAuthorization, cancel?: boolean) => Promise<string | null>;
  cashSession: (payload: Record<string, unknown>, authorization: ManagerAuthorization, close?: boolean) => Promise<string>;
  returnSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string>;
  voidSale: (payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string>;
  collectDeliveryPayment: (payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string>;
  checkoutTableOrder: (payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string>;
  inventoryCommand: (command: string, payload: Record<string, unknown>, authorization: ManagerAuthorization) => Promise<string>;
  localStatus: () => Promise<{ state: 'not_configured' | 'configured'; origin?: string; caFingerprint?: string; deviceCertificateRef?: string | null }>;
  enrollLocalTerminal: () => Promise<{ certificateRef: string }>;
  localRequest: (path: string, body?: unknown) => Promise<unknown>;
  subscribeLocalEvents: (callback: (payload: { state: 'not_configured' }) => void) => () => void;
  platform: NodeJS.Platform;
}

declare global {
  interface Window { electron?: ElectronBridge; }
}
export {};
