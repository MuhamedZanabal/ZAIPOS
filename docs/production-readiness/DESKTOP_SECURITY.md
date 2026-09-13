# Desktop native trust boundary

The production desktop is Electron, not Tauri. Every renderer-to-main handler (settings, kiosk, printer, drawer, updater and external links) registers through `handleTrustedIpc`.

Before a handler can execute, its sender must be the current main window's web contents, its sender frame must be that window's main frame, and its URL must match the packaged document. An iframe, detached frame, foreign window, destroyed window or navigated document is rejected. Packaged builds ignore the development-server environment variable; unpackaged development accepts an explicit loopback server only.

Navigation and redirects outside the application document/origin are prevented. New renderer-created windows and attached webviews are denied. Native external opening is restricted to explicitly requested HTTP/HTTPS URLs without credentials/control characters. Courier map links use this explicit bridge. Unreviewed browser permission requests are denied.

Production builds add a Content Security Policy: self-hosted scripts only, no plugin objects or frames, fixed font providers, and HTTPS/WSS network endpoints. Inline styles remain necessary for the component system; inline scripts and eval are not allowed. Development HMR uses Vite's development policy. Context isolation, renderer sandboxing, disabled Node integration and web security are explicit.

## Verification

`src/test/desktop/trust-boundary.test.ts` executes the real registration/guard code with native effects intercepted. It verifies sender rejection before privileged effects, strict document/origin matching, external protocol rejection, blocked navigation/popups/webviews and denied permissions. These are security boundary tests, not physical printer or Windows installation acceptance.

Review reference: [Electron security recommendations](https://www.electronjs.org/docs/latest/tutorial/security), especially navigation, new windows, external links, CSP and IPC sender validation.

## Remaining boundaries

Sender validation identifies trusted application code, not the cashier's business role. PostgreSQL remains responsible for financial authorization. Native settings/kiosk authorization and device-path/payload validation require their own manager/session enforcement review; a renderer compromise must not be treated as equivalent to verified manager approval. Hardware effects still need deployed-device acceptance.
