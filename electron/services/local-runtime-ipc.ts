import { handleTrustedIpc } from '../security.js';
import { IPC_HANDLERS } from '../types.js';
import { LocalServiceError } from './local-service-client.js';
import { createLocalRuntime, type LocalProfileStore } from './local-runtime.js';

export function registerLocalRuntimeIpc(store: LocalProfileStore): void {
  const runtime = createLocalRuntime(store);
  handleTrustedIpc(IPC_HANDLERS.LOCAL_STATUS, () => runtime.status());
  handleTrustedIpc(IPC_HANDLERS.LOCAL_ENROLL, () => runtime.enroll());
  handleTrustedIpc(IPC_HANDLERS.LOCAL_REQUEST, (_event, path: unknown, body: unknown) => {
    if (typeof path !== 'string') throw new LocalServiceError('LOCAL_PROFILE_INVALID');
    return runtime.request(path, undefined, body);
  });
  handleTrustedIpc(IPC_HANDLERS.LOCAL_SUBSCRIBE, () => runtime.subscribe());
}
