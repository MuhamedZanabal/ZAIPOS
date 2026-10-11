import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { TicketData } from '../types.js';
import { bitmapToEscPosRaster, buildBilingualReceiptHtml, contentHeight, receiptDotWidth } from './receipt-raster.js';

let fonts: { regular: string; bold: string } | null = null;
function loadFonts(): { regular: string; bold: string } {
  if (fonts) return fonts;
  const dir = path.join(__dirname, '../dist/fonts');
  fonts = {
    regular: fs.readFileSync(path.join(dir, 'noto-sans-arabic-arabic-400-normal.woff2')).toString('base64'),
    bold: fs.readFileSync(path.join(dir, 'noto-sans-arabic-arabic-700-normal.woff2')).toString('base64'),
  };
  return fonts;
}

/** Renders the bilingual receipt offscreen (sandboxed, no scripts, no network) and returns ESC/POS raster bytes. */
export async function renderBilingualReceipt(data: TicketData, charWidth: number): Promise<Buffer> {
  const width = receiptDotWidth(charWidth);
  const html = buildBilingualReceiptHtml(data, width, loadFonts());
  const win = new BrowserWindow({
    show: false, width, height: 3000, useContentSize: true,
    webPreferences: { offscreen: true, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`);
    await new Promise((r) => setTimeout(r, 150));
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    const height = contentHeight(size.width, size.height, bitmap, true) + 24;
    return bitmapToEscPosRaster(size.width, Math.min(height, size.height), bitmap, { bgra: true });
  } finally {
    win.destroy();
  }
}
