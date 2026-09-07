import { ipcMain, BrowserWindow, dialog } from 'electron';
import { IPC_EVENTS, IPC_HANDLERS } from '../types.js';
import type { AppSettings } from '../types.js';

type UpdateChannel = AppSettings['updateChannel'];

let autoUpdater: any = null;

async function loadUpdater() {
  if (!autoUpdater) {
    try {
      const { autoUpdater: updater } = await import('electron-updater');
      autoUpdater = updater;
    } catch (error) {
      console.warn('[Updater] electron-updater is unavailable:', error);
    }
  }
  return autoUpdater;
}

function resolveUpdateChannel(configured: UpdateChannel): UpdateChannel {
  const requested = process.env.POS_UPDATE_CHANNEL;
  return requested === 'beta' || requested === 'stable' ? requested : configured;
}

export async function setupUpdater(
  mainWindow: BrowserWindow,
  configuredChannel: UpdateChannel = 'stable',
): Promise<void> {
  const updater = await loadUpdater();
  if (!updater) return;

  if (process.env.VITE_DEV_SERVER_URL) {
    console.info('[Updater] Development mode detected; release updates are disabled.');
    return;
  }

  if (process.env.POS_DISABLE_AUTO_UPDATE === 'true') {
    console.info('[Updater] Update checks explicitly disabled for this terminal.');
    return;
  }

  const channel = resolveUpdateChannel(configuredChannel);
  updater.channel = channel === 'beta' ? 'beta' : 'latest';
  updater.allowPrerelease = channel === 'beta';
  updater.allowDowngrade = false;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on('update-available', (info: any) => {
    console.info('[Updater] Update available', { version: info.version, channel });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.UPDATE_AVAILABLE, {
        version: info.version,
        releaseNotes: info.releaseNotes,
        releaseDate: info.releaseDate,
        channel,
      });
    }
  });

  updater.on('update-not-available', (info: any) => {
    console.info('[Updater] Terminal is current', { version: info?.version, channel });
  });

  updater.on('download-progress', (progress: any) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.DOWNLOAD_PROGRESS, {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  updater.on('update-downloaded', (info: any) => {
    console.info('[Updater] Update downloaded', { version: info.version, channel });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_EVENTS.UPDATE_DOWNLOADED, {
        version: info.version,
      });
    }
  });

  updater.on('error', (error: Error) => {
    console.error('[Updater] Update operation failed', { message: error.message, channel });
  });

  ipcMain.handle(IPC_HANDLERS.DOWNLOAD_UPDATE, async () => {
    try {
      await updater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Updater] Download failed', { message, channel });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC_HANDLERS.INSTALL_UPDATE, async () => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Install and restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: 'The update is ready to install.',
      detail: 'ZAIPOS will restart to complete the installation.',
    });

    if (result.response === 0) updater.quitAndInstall(false, true);
  });

  setTimeout(() => {
    updater.checkForUpdates().catch((error: Error) => {
      console.warn('[Updater] Update check failed', { message: error.message, channel });
    });
  }, 5000);

  console.info('[Updater] Update service ready', { channel, autoDownload: false });
}
