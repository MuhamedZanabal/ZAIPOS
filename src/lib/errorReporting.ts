/** Forwards renderer crashes to the desktop app's local error log (no third-party service). */
export function report(error: unknown, route = typeof location === 'undefined' ? '' : location.hash) {
  const bridge = typeof window === 'undefined' ? undefined : window.electron?.reportError;
  if (!bridge) return;
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown error');
  void bridge({ message: e.message || 'Unknown error', stack: e.stack, route }).catch(() => undefined);
}

let installed = false;
export function installErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => report(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => report(event.reason));
}
