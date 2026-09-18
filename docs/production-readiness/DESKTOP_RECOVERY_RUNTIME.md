# Desktop cash recovery runtime contract

The cash journal relies on Web Locks and localStorage. Mocked UI tests prove application behavior but cannot prove these primitives work under Electron's production `file:` origin. `scripts/test-desktop-cash-recovery.cjs` runs the installed, lockfile-pinned Electron binary with two isolated hidden windows, sandboxed renderers, context isolation and no Node integration. It verifies exclusive locking across windows, exact shared draft persistence, renderer reload recovery and lock release after renderer destruction. A 30-second watchdog fails stalled runs. It uses only a disposable test profile and fixture, with no production credentials or data.

The CI Windows packaging job and the signed-release workflow run this contract. The script disables hardware acceleration because this is a storage/locking test, not graphical or hardware acceptance. It does not disable Electron's security sandbox in Windows CI. Temporary profiles are isolated in the runner's temporary directory.

Local Linux attempts failed in display initialization before these assertions, even with the headless backend; these failures are environment limitations, not evidence that recovery passed or failed. Windows results must be recorded before this item can be marked verified.

This proves the tested renderer primitives, not full installer acceptance, process-level crash durability, physical disk flush guarantees, abrupt power-loss recovery, printer/cash drawer behavior or production Authenticode signing. Those remain separate gates. See the [Web Locks specification](https://www.w3.org/TR/web-locks/) for origin-scoped lock semantics and the [Electron BrowserWindow API](https://www.electronjs.org/docs/latest/api/browser-window) for the runtime container.
