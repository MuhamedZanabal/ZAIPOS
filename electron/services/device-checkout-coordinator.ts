import type { DeviceAuthorization } from '../types.js';
import type { OfflineDrainSummary } from './device-offline-orchestrator.js';

type CheckoutPayload = Record<string, unknown>;
type Dependencies = {
  checkout(payload: CheckoutPayload, authorization: DeviceAuthorization): Promise<string>;
  readActive(authorization: DeviceAuthorization): unknown;
  refresh(authorization: DeviceAuthorization): Promise<unknown>;
  orchestrator: { enabled: boolean; drain(authorization: DeviceAuthorization): Promise<OfflineDrainSummary> };
  report(summary: OfflineDrainSummary): void;
  reportFailure(message: string): void;
};

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
    async checkout(payload: CheckoutPayload, authorization: DeviceAuthorization): Promise<string> {
      const saleId = await dependencies.checkout(payload, authorization);
      if (dependencies.orchestrator.enabled) void reconcileAfterAuthenticatedCheckout(authorization);
      return saleId;
    },
  };
}
