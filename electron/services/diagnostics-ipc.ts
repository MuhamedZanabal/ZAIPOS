import { app, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleTrustedIpc } from '../security.js';
import { IPC_HANDLERS } from '../types.js';
import { setLogSink, log } from '../logger.js';
import { diagnosticsBundle, rendererErrorEntry, RotatingLog } from './error-log.js';

let errorLog: RotatingLog | null = null;

/** Starts the rotating error log under the app's logs folder and captures crashes. */
export function setupErrorReporting(): RotatingLog {
  errorLog = new RotatingLog(app.getPath('logs'));
  setLogSink((entry) => errorLog?.append(entry));
  process.on('uncaughtException', (error) => log('error', 'uncaught_exception', { message: error.message, stack: error.stack }));
  process.on('unhandledRejection', (reason) => log('error', 'unhandled_rejection', { message: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined }));
  app.on('render-process-gone', (_event, _contents, details) => log('error', 'renderer_gone', { reason: details.reason, exitCode: details.exitCode }));
  app.on('child-process-gone', (_event, details) => log('error', 'child_process_gone', { type: details.type, reason: details.reason, exitCode: details.exitCode }));

  let recent = 0, windowStart = Date.now();
  handleTrustedIpc(IPC_HANDLERS.REPORT_RENDERER_ERROR, (_event, value: unknown) => {
    // Rate-limited so a render loop cannot flood the disk.
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); recent = 0; }
    if (++recent > 30) return;
    const entry = rendererErrorEntry(value);
    if (entry) errorLog?.append(entry);
  });

  handleTrustedIpc(IPC_HANDLERS.EXPORT_DIAGNOSTICS, async (event) => {
    if (!errorLog) return { saved: false };
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const options = { title: 'Save ZAIPOS diagnostics', defaultPath: path.join(app.getPath('documents'), `zaipos-diagnostics-${stamp}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };
    const bundle = diagnosticsBundle(errorLog, {
      appVersion: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${os.release()} ${process.arch}`,
      memoryMB: Math.round(os.totalmem() / 1048576), uptimeMin: Math.round(process.uptime() / 60), logFiles: errorLog.files().map((f) => path.basename(f)),
    });
    fs.writeFileSync(result.filePath, bundle, { mode: 0o600 });
    log('info', 'diagnostics_exported');
    return { saved: true, path: result.filePath };
  });
  return errorLog;
}
