import type { DeviceAuthorization } from '../types.js';
import type { OfflineDrainSummary } from './device-offline-orchestrator.js';

type CheckoutPayload = Record<string, unknown>;
type CaptureInput = {
  authorization: DeviceAuthorization;
  kind: 'checkout.sale';
  payload: Record<string, unknown>;
  mutationId?: string;
};
export type NativeCheckoutResult = string | Readonly<{ status: 'pending'; mutationId: string }>;
type Dependencies = {
  checkout(payload: CheckoutPayload, authorization: DeviceAuthorization): Promise<string>;
  readActive(authorization: DeviceAuthorization): unknown;
  refresh(authorization: DeviceAuthorization): Promise<unknown>;
  orchestrator: { enabled: boolean; capture(input: CaptureInput): string; drain(authorization: DeviceAuthorization): Promise<OfflineDrainSummary> };
  report(summary: OfflineDrainSummary): void;
  reportFailure(message: string): void;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PAYLOAD_KEYS = new Set(['_lease_token', '_device_credential', 'token', 'credential', 'encryptedCredential', 'leaseToken', 'deviceCredential']);

function isTransientNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /failed to fetch|fetch failed|networkerror|network error|load failed|err_network|internet disconnected|econnreset|etimedout|enotfound|socket/i.test(message);
}

function mutationIdFromPayload(payload: CheckoutPayload): string | undefined {
  const value = payload._client_mutation_id ?? payload._mutation_id;
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

function capturePayload(payload: CheckoutPayload): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_PAYLOAD_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function createDeviceCheckoutCoordinator(dependencies: Dependencies) {
  const reconcileAfterAuthenticatedCheckout = async (authorization: DeviceAuthorization): Promise<void> => {
    try {
      try { dependencies.readActive(authorization); }
      catch { await dependencies.refresh(authorization); }
      const summary = await dependencies.orchestrator.drain(authorization);
      dependencies.report(summary);
    } catch (error: any) {
      dependencies.reportFailure(error?.message ?? String(error));
    }
  };
  return {
    async checkout(payload: CheckoutPayload, authorization: DeviceAuthorization): Promise<NativeCheckoutResult> {
      try {
        const saleId = await dependencies.checkout(payload, authorization);
        if (dependencies.orchestrator.enabled) void reconcileAfterAuthenticatedCheckout(authorization);
        return saleId;
      } catch (error) {
        if (!dependencies.orchestrator.enabled || !isTransientNetworkFailure(error)) throw error;
        const mutationId = dependencies.orchestrator.capture({
          authorization,
          kind: 'checkout.sale',
          payload: capturePayload(payload),
          mutationId: mutationIdFromPayload(payload),
        });
        return Object.freeze({ status: 'pending' as const, mutationId });
      }
    },
  };
}
