/**
 * electron/types.ts
 * Shared types for Electron main/renderer IPC.
 */

export interface TicketItem { name: string; quantity: number; unitPrice: number; discountAmount?: number; taxRate?: number; total: number; }
export interface TicketPayment { method: string; amount: number; reference?: string; }
export interface TicketData {
  ticketNumber: string | number; businessName: string; branchName?: string; address?: string; phone?: string;
  items: TicketItem[]; subtotal: number; discountTotal: number; tipAmount: number; taxTotal: number; total: number;
  payments: TicketPayment[]; customerName?: string; cashierName?: string; notes?: string; qrData?: string; date?: string;
  isReprint?: boolean; saleStatus?: string; reprintEventId?: string;
}
export interface PrintResult { ok: boolean; error?: string; }
export type PrinterConnectionType = 'usb' | 'network' | 'bluetooth';
export interface PrinterConfig { connectionType: PrinterConnectionType; devicePath?: string; host?: string; port?: number; bluetoothAddress?: string; width?: number; characterSet?: string; }
export type BarcodeScannerMode = 'hid' | 'serial';
export interface BarcodeConfig { mode: BarcodeScannerMode; serialPort?: string; baudRate?: number; }
export interface AppSettings { kiosk: boolean; updateChannel: 'stable' | 'beta'; printer: PrinterConfig; barcode: BarcodeConfig; }
export const DEFAULT_SETTINGS: AppSettings = { kiosk: false, updateChannel: 'stable', printer: { connectionType: 'usb', devicePath: process.platform === 'win32' ? '\\\\.\\COM1' : '/dev/usb/lp0', width: 42, characterSet: 'SLOVENIA' }, barcode: { mode: 'hid', baudRate: 9600 } };

export interface DeviceCredentialIdentity { tenantId: string; branchId: string; deviceUid: string; }
export type DeviceCredentialStatus = (DeviceCredentialIdentity & { configured: true; protectedByOs: boolean }) | { configured: false; protectedByOs: boolean };
/** Main-process-only server-issued bounded capability. Token must never cross the preload bridge. */
export interface DeviceOfflineLease { leaseId: string; token: string; issuedAt: string; expiresAt: string; }

export const IPC_EVENTS = { BARCODE_SCANNED: 'barcode-scanned', UPDATE_AVAILABLE: 'update-available', UPDATE_DOWNLOADED: 'update-downloaded', DOWNLOAD_PROGRESS: 'download-progress' } as const;
export const IPC_HANDLERS = {
  PRINT_TICKET: 'print-ticket', OPEN_DRAWER: 'open-drawer', GET_SETTINGS: 'get-settings', SAVE_SETTINGS: 'save-settings', SET_KIOSK: 'set-kiosk', DOWNLOAD_UPDATE: 'download-update', INSTALL_UPDATE: 'install-update', OPEN_EXTERNAL: 'open-external', GET_APP_VERSION: 'get-app-version', GET_DEVICE_CREDENTIAL_STATUS: 'get-device-credential-status', GET_DEVICE_IDENTITY: 'get-device-identity', ACTIVATE_DEVICE: 'activate-device', ROTATE_DEVICE_CREDENTIAL: 'rotate-device-credential', REVOKE_DEVICE: 'revoke-device', DEVICE_CHECKOUT: 'device-checkout', DEVICE_CASH_MOVEMENT: 'device-cash-movement', DEVICE_CASH_SESSION: 'device-cash-session', DEVICE_SALE_RETURN: 'device-sale-return', DEVICE_SALE_VOID: 'device-sale-void', DEVICE_DELIVERY_COLLECTION: 'device-delivery-collection', DEVICE_TABLE_CHECKOUT: 'device-table-checkout', DEVICE_INVENTORY_COMMAND: 'device-inventory-command'
} as const;
export interface ManagerAuthorization { accessToken: string; tenantId: string; branchId: string; }
export interface DeviceAuthorization extends ManagerAuthorization {}
