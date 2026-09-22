import { safeStorage } from 'electron';

type CredentialRecord = { deviceUid: string; tenantId?: string; branchId?: string; encryptedCredential?: string };
type CredentialStore = { get(key: string): unknown; set(key: string, value: unknown): void };
export interface DeviceAuthorization { accessToken: string; tenantId: string; branchId: string }
export type DeviceCheckoutPayload = Record<string, unknown> & { _tenant_id: string; _branch_id: string };
export type DeviceCashMovementPayload = {
  _tenant_id: string; _branch_id: string; _session_id: string; _type: 'in' | 'out';
  _amount: string; _reason: string; _reference: string;
};
export type DeviceSaleReturnPayload = {
  _tenant_id: string; _branch_id: string; _sale_id: string;
  _items: Array<{ sale_item_id: string; quantity: number }>;
  _reason_code: 'damaged' | 'wrong_item' | 'quality' | 'customer_request' | 'other';
  _client_mutation_id: string; _cash_session_id: string | null;
  _reason: string | null; _evidence_url: string | null;
};
export type DeviceSaleVoidPayload = {
  _tenant_id: string; _branch_id: string; _sale_id: string;
  _client_mutation_id: string; _cash_session_id: string | null; _reason: string | null;
};
export type DeviceCustomerCreditPaymentPayload = {
  _tenant_id: string; _branch_id: string; _customer_id: string;
  _amount_fils: string;
  _payment_method: 'cash' | 'card' | 'benefitpay' | 'bank_transfer' | 'cheque' | 'other';
  _payment_reference: string; _operation_id: string;
};
const RECORD_KEY = 'enrollment';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireString(value: unknown, label: string, max = 4096): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`); return value.trim(); }
function requireCanonicalString(value: unknown, label: string, min: number, max: number): string { if (typeof value !== 'string' || value.length < min || value.length > max || value !== value.trim()) throw new Error(`Invalid ${label}`); return value; }
function requireUuid(value: unknown, label: string): string { const valueString = requireString(value, label, 128); if (!UUID.test(valueString)) throw new Error(`Invalid ${label}`); return valueString; }
function requireExactBhd(value: unknown): string { const amount = requireString(value, 'cash amount', 32); const match = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(amount); if (!match) throw new Error('Invalid exact cash amount'); const fils = BigInt(match[1]) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0')); if (fils <= 0n) throw new Error('Invalid exact cash amount'); return amount; }
function requirePositiveFils(value: unknown): string { const fils = requireCanonicalString(value, 'exact fils amount', 1, 19); if (!/^[1-9]\d*$/.test(fils) || BigInt(fils) > 9223372036854775807n) throw new Error('Invalid exact fils amount'); return fils; }
function optionalUuid(value: unknown, label: string): string | null { return value === null || value === undefined ? null : requireUuid(value, label); }
function optionalCanonicalString(value: unknown, label: string, max: number): string | null { if (value === null || value === undefined) return null; return requireCanonicalString(value, label, 1, max); }
function validateAuthorization(auth: DeviceAuthorization): DeviceAuthorization { return { accessToken: requireString(auth?.accessToken, 'access token', 16384), tenantId: requireUuid(auth?.tenantId, 'tenant ID'), branchId: requireUuid(auth?.branchId, 'branch ID') }; }
function rpcUrl(baseUrl: string, functionName: string): string { const parsed = new URL(requireString(baseUrl, 'Supabase URL', 2048)); if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Supabase URL must use HTTPS'); parsed.pathname = `/rest/v1/rpc/${functionName}`; parsed.search = ''; parsed.hash = ''; return parsed.href; }
function edgeUrl(baseUrl: string, functionName: string): string { const parsed = new URL(rpcUrl(baseUrl, 'placeholder')); parsed.pathname = `/functions/v1/${functionName}`; return parsed.href; }
async function callRpc(baseUrl: string, publishableKey: string, accessToken: string, name: string, body: unknown): Promise<unknown> { const response = await fetch(rpcUrl(baseUrl, name), { method: 'POST', headers: { apikey: requireString(publishableKey, 'Supabase publishable key', 8192), authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await response.text(); let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null; } catch { if (response.ok) throw new Error('Device authority returned malformed JSON'); } if (!response.ok) { const detail = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; const error = new Error(typeof detail.message === 'string' ? detail.message : `Device authority request failed (${response.status})`) as Error & { code?: string }; if (typeof detail.code === 'string') error.code = detail.code; throw error; } return parsed; }
async function callEdge(baseUrl: string, publishableKey: string, accessToken: string, name: string, body: unknown): Promise<unknown> { const response = await fetch(edgeUrl(baseUrl, name), { method: 'POST', headers: { apikey: requireString(publishableKey, 'Supabase publishable key', 8192), authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await response.text(); if (!response.ok) throw new Error(`Device ${name} failed (${response.status})`); return text ? JSON.parse(text) : null; }
function extractCredential(value: unknown): string { const row = Array.isArray(value) ? value[0] : value; const credential = typeof row === 'object' && row !== null ? (row as Record<string, unknown>).credential : row; if (typeof credential !== 'string' || !/^[0-9a-f]{64}$/i.test(credential)) throw new Error('Device authority returned an invalid credential'); return credential; }
export function createDeviceCredentialService(store: CredentialStore, baseUrl: string, publishableKey: string) {
  const readRecord = (): CredentialRecord => { const value = store.get(RECORD_KEY); if (!value || typeof value !== 'object') return { deviceUid: crypto.randomUUID() }; const record = value as Partial<CredentialRecord>; return { deviceUid: requireString(record.deviceUid, 'device UID', 128), tenantId: record.tenantId === undefined ? undefined : requireUuid(record.tenantId, 'stored tenant ID'), branchId: record.branchId === undefined ? undefined : requireUuid(record.branchId, 'stored branch ID'), encryptedCredential: record.encryptedCredential }; };
  const ensureRecord = (): CredentialRecord => { const existing = store.get(RECORD_KEY); if (existing) return readRecord(); const record = { deviceUid: crypto.randomUUID() }; store.set(RECORD_KEY, record); return record; };
  const requireProvisionedScope = (auth: DeviceAuthorization): CredentialRecord => { const record = readRecord(); if (!record.encryptedCredential || !record.tenantId || !record.branchId) throw new Error('This terminal is not provisioned'); if (record.tenantId !== auth.tenantId || record.branchId !== auth.branchId) throw new Error('Stored device credential scope does not match authorization scope'); return record; };
  const decryptCredential = (record: CredentialRecord): string => { if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable'); let credential: string; try { credential = safeStorage.decryptString(Buffer.from(record.encryptedCredential!, 'base64')); } catch { throw new Error('Stored device credential cannot be decrypted'); } if (!/^[0-9a-f]{64}$/i.test(credential)) throw new Error('Stored device credential is invalid'); return credential; };
  return {
    identity(): { deviceUid: string; provisioned: boolean } { const record = ensureRecord(); return { deviceUid: record.deviceUid, provisioned: Boolean(record.encryptedCredential) }; },
    async activate(approvalId: string, appVersion: string, os: string, authorization: DeviceAuthorization): Promise<{ deviceUid: string; provisioned: true }> {
      const auth = validateAuthorization(authorization); if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable'); const record = ensureRecord();
      if (record.encryptedCredential && (record.tenantId !== auth.tenantId || record.branchId !== auth.branchId)) throw new Error('This terminal is already provisioned for a different tenant or branch');
      const result = await callEdge(baseUrl, publishableKey, auth.accessToken, 'activate-device', { approval_id: requireString(approvalId, 'approval ID', 128), device_uid: record.deviceUid, app_version: requireString(appVersion, 'app version', 64), os: requireString(os, 'operating system', 64) });
      const credential = extractCredential(result); const resultRow = Array.isArray(result) ? result[0] : result; if (typeof resultRow !== 'object' || resultRow === null || (resultRow as Record<string, unknown>).device_uid !== record.deviceUid) throw new Error('Device activation identity mismatch');
      const encryptedCredential = safeStorage.encryptString(credential).toString('base64'); store.set(RECORD_KEY, { deviceUid: record.deviceUid, tenantId: auth.tenantId, branchId: auth.branchId, encryptedCredential }); return { deviceUid: record.deviceUid, provisioned: true };
    },
    async rotate(approvalId: string, authorization: DeviceAuthorization): Promise<{ deviceUid: string; provisioned: true }> {
      const auth = validateAuthorization(authorization); if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable'); const record = requireProvisionedScope(auth);
      const result = await callEdge(baseUrl, publishableKey, auth.accessToken, 'rotate-device-credential', { approval_id: requireString(approvalId, 'approval ID', 128), device_uid: record.deviceUid });
      const credential = extractCredential(result); const resultRow = Array.isArray(result) ? result[0] : result; if (typeof resultRow !== 'object' || resultRow === null || (resultRow as Record<string, unknown>).device_uid !== record.deviceUid) throw new Error('Device rotation identity mismatch');
      const encryptedCredential = safeStorage.encryptString(credential).toString('base64'); store.set(RECORD_KEY, { deviceUid: record.deviceUid, tenantId: auth.tenantId, branchId: auth.branchId, encryptedCredential }); return { deviceUid: record.deviceUid, provisioned: true };
    },
    async revoke(deviceId: string, authorization: DeviceAuthorization): Promise<{ deviceUid: string; provisioned: false; revoked: boolean }> {
      const auth = validateAuthorization(authorization); const record = requireProvisionedScope(auth);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, 'revoke_device_enrollment', { _tenant_id: auth.tenantId, _device_id: requireUuid(deviceId, 'device ID'), _reason: 'manager_console_revocation' });
      if (typeof result !== 'boolean') throw new Error('Device revocation returned an invalid result');
      store.set(RECORD_KEY, { deviceUid: record.deviceUid });
      return { deviceUid: record.deviceUid, provisioned: false, revoked: result };
    },
    async checkout(payload: DeviceCheckoutPayload, authorization: DeviceAuthorization): Promise<string> {
      const auth = validateAuthorization(authorization); if (!payload || payload._tenant_id !== auth.tenantId || payload._branch_id !== auth.branchId) throw new Error('Checkout scope does not match authorization scope'); if (!safeStorage.isEncryptionAvailable()) throw new Error('Operating-system credential encryption is unavailable'); const record = requireProvisionedScope(auth);
      const credential = decryptCredential(record);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, 'checkout_sale_v2_device', { ...payload, _device_uid: record.deviceUid, _device_credential: credential }); if (typeof result !== 'string') throw new Error('Checkout returned an invalid sale identifier'); return result;
    },
    async cashMovement(payload: DeviceCashMovementPayload, authorization: DeviceAuthorization, cancel = false): Promise<string | null> {
      const auth = validateAuthorization(authorization);
      if (!payload || payload._tenant_id !== auth.tenantId || payload._branch_id !== auth.branchId) throw new Error('Cash movement scope does not match authorization scope');
      const request = {
        _tenant_id: requireUuid(payload._tenant_id, 'tenant ID'), _branch_id: requireUuid(payload._branch_id, 'branch ID'),
        _session_id: requireUuid(payload._session_id, 'cash session ID'),
        _type: payload._type, _amount: requireExactBhd(payload._amount),
        _reason: requireCanonicalString(payload._reason, 'cash movement reason', 2, 500),
        _reference: requireCanonicalString(payload._reference, 'cash movement reference', 8, 128),
      };
      if (!['in', 'out'].includes(request._type)) throw new Error('Invalid cash movement request');
      const record = requireProvisionedScope(auth); const credential = decryptCredential(record);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, cancel ? 'cancel_cash_movement_v3_device' : 'record_cash_movement_v3_device', { ...request, _device_uid: record.deviceUid, _device_credential: credential });
      if (result !== null && (typeof result !== 'string' || !UUID.test(result))) throw new Error('Cash movement returned an invalid receipt');
      if (!cancel && result === null) throw new Error('Cash movement returned no receipt');
      return result;
    },
    async customerCreditPayment(payload: DeviceCustomerCreditPaymentPayload, authorization: DeviceAuthorization): Promise<string> {
      const auth = validateAuthorization(authorization);
      if (!payload || payload._tenant_id !== auth.tenantId || payload._branch_id !== auth.branchId) throw new Error('Customer credit payment scope does not match authorization scope');
      const paymentMethod = requireCanonicalString(payload._payment_method, 'customer credit payment method', 2, 32);
      if (!['cash', 'card', 'benefitpay', 'bank_transfer', 'cheque', 'other'].includes(paymentMethod)) throw new Error('Invalid customer credit payment method');
      const request = {
        _tenant_id: requireUuid(payload._tenant_id, 'tenant ID'), _branch_id: requireUuid(payload._branch_id, 'branch ID'),
        _customer_id: requireUuid(payload._customer_id, 'customer ID'),
        _amount_fils: requirePositiveFils(payload._amount_fils),
        _payment_method: paymentMethod,
        _payment_reference: requireCanonicalString(payload._payment_reference, 'customer credit payment reference', 2, 256),
        _operation_id: requireCanonicalString(payload._operation_id, 'customer credit operation ID', 8, 128),
      };
      const record = requireProvisionedScope(auth); const credential = decryptCredential(record);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, 'record_customer_credit_payment_v2_device', { ...request, _device_uid: record.deviceUid, _device_credential: credential });
      if (typeof result !== 'string' || !UUID.test(result)) throw new Error('Customer credit payment returned an invalid identifier');
      return result;
    },
    async returnSale(payload: DeviceSaleReturnPayload, authorization: DeviceAuthorization): Promise<string> {
      const auth = validateAuthorization(authorization);
      if (!payload || payload._tenant_id !== auth.tenantId || payload._branch_id !== auth.branchId) throw new Error('Sale return scope does not match authorization scope');
      if (!Array.isArray(payload._items) || payload._items.length < 1 || payload._items.length > 500) throw new Error('Invalid sale return items');
      const items = payload._items.map((item) => {
        if (!item || typeof item !== 'object' || !Number.isFinite(item.quantity) || item.quantity <= 0 || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 1e-9) throw new Error('Invalid sale return item quantity');
        return { sale_item_id: requireUuid(item.sale_item_id, 'sale item ID'), quantity: item.quantity };
      });
      const reasonCode = requireCanonicalString(payload._reason_code, 'sale return reason code', 2, 64);
      if (!['damaged', 'wrong_item', 'quality', 'customer_request', 'other'].includes(reasonCode)) throw new Error('Invalid sale return reason code');
      const request = {
        _tenant_id: requireUuid(payload._tenant_id, 'tenant ID'), _branch_id: requireUuid(payload._branch_id, 'branch ID'),
        _sale_id: requireUuid(payload._sale_id, 'sale ID'), _items: items, _reason_code: reasonCode,
        _client_mutation_id: requireCanonicalString(payload._client_mutation_id, 'sale return mutation ID', 8, 128),
        _cash_session_id: optionalUuid(payload._cash_session_id, 'cash session ID'),
        _reason: optionalCanonicalString(payload._reason, 'sale return reason', 500),
        _evidence_url: optionalCanonicalString(payload._evidence_url, 'sale return evidence URL', 2048),
      };
      const record = requireProvisionedScope(auth); const credential = decryptCredential(record);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, 'process_sale_return_v3_device', { ...request, _device_uid: record.deviceUid, _device_credential: credential });
      if (typeof result !== 'string' || !UUID.test(result)) throw new Error('Sale return returned an invalid identifier');
      return result;
    },
    async voidSale(payload: DeviceSaleVoidPayload, authorization: DeviceAuthorization): Promise<string> {
      const auth = validateAuthorization(authorization);
      if (!payload || payload._tenant_id !== auth.tenantId || payload._branch_id !== auth.branchId) throw new Error('Sale void scope does not match authorization scope');
      const request = {
        _tenant_id: requireUuid(payload._tenant_id, 'tenant ID'), _branch_id: requireUuid(payload._branch_id, 'branch ID'),
        _sale_id: requireUuid(payload._sale_id, 'sale ID'),
        _client_mutation_id: requireCanonicalString(payload._client_mutation_id, 'sale void mutation ID', 8, 128),
        _cash_session_id: optionalUuid(payload._cash_session_id, 'cash session ID'),
        _reason: optionalCanonicalString(payload._reason, 'sale void reason', 500),
      };
      const record = requireProvisionedScope(auth); const credential = decryptCredential(record);
      const result = await callRpc(baseUrl, publishableKey, auth.accessToken, 'process_sale_void_v3_device', { ...request, _device_uid: record.deviceUid, _device_credential: credential });
      if (typeof result !== 'string' || !UUID.test(result)) throw new Error('Sale void returned an invalid identifier');
      return result;
    },
  };
}
