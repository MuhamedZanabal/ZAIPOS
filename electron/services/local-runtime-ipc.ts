import { handleTrustedIpc } from '../security.js';
import { IPC_HANDLERS } from '../types.js';
import { LocalServiceError } from './local-service-client.js';
import { createLocalRuntime, type LocalProfileStore, type ServiceNoticeCode } from './local-runtime.js';

export function registerLocalRuntimeIpc(store: LocalProfileStore, readNotice?: () => ServiceNoticeCode | null): void {
  const runtime = createLocalRuntime(store);
  handleTrustedIpc(IPC_HANDLERS.LOCAL_STATUS, () => {
    const status = runtime.status();
    if (status.state === 'configured') return status;
    const reason = readNotice?.() ?? null;
    return reason ? { ...status, reason } : status;
  });
  handleTrustedIpc(IPC_HANDLERS.LOCAL_ENROLL, () => runtime.enroll());
  handleTrustedIpc(IPC_HANDLERS.LOCAL_REQUEST, (_event, path: unknown, body: unknown) => {
    if (typeof path !== 'string') throw new LocalServiceError('LOCAL_PROFILE_INVALID');
    return runtime.request(path, undefined, body);
  });
  handleTrustedIpc(IPC_HANDLERS.LOCAL_SUBSCRIBE, () => runtime.subscribe());
}
