import { handleTrustedIpc } from '../security.js';
/**
 * electron/services/printer.ts
 * Servicio de impresora térmica ESC/POS para el Main Process.
 * Soporta conexión por USB, Red/IP y Bluetooth.
 * Usa la librería node-thermal-printer.
 */

import { BrowserWindow } from 'electron';
import type { TicketData, PrintResult, PrinterConfig } from '../types.js';
import { IPC_HANDLERS } from '../types.js';
import { printerInterface, validatePrinterConfig, validateTicket } from '../hardware-security.js';
import { log } from '../logger.js';
import { buildReceiptTextLines } from './receipt-format.js';

// Importamos de forma lazy para que el app arranque aunque la impresora no esté conectada
let ThermalPrinter: any;
let PrinterTypes: any;
let CharacterSet: any;

async function loadPrinterLibrary() {
  if (!ThermalPrinter) {
    try {
      const lib = await import('node-thermal-printer');
      ThermalPrinter = lib.ThermalPrinter;
      PrinterTypes = lib.PrinterTypes;
      CharacterSet = lib.CharacterSet;
    } catch (err) {
      log('error', 'printer_library_unavailable');
      throw new Error('Printer library unavailable');
    }
  }
}

// ─── Builder de Ticket ──────────────────────────────────────────────────────

async function createPrinterInstance(config: PrinterConfig): Promise<any> {
  config = validatePrinterConfig(config);
  const destination = printerInterface(config);
  await loadPrinterLibrary();

  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: destination,
    width: config.width ?? 42,
    characterSet: CharacterSet[config.characterSet ?? 'SLOVENIA'] ?? CharacterSet.SLOVENIA,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
  });

  return printer;
}

// ─── Impresión de Ticket ────────────────────────────────────────────────────

export async function printTicket(
  config: PrinterConfig,
  data: TicketData
): Promise<PrintResult> {
  try {
    validateTicket(data);
    const printer = await createPrinterInstance(config);
    const width = config.width ?? 42;
    printer.alignLeft();
    for (const line of buildReceiptTextLines(data, width)) printer.println(line);

    // ── QR Code ──────────────────────────────────────────────────────────────
    if (data.qrData) {
      printer.newLine();
      printer.alignCenter();
      printer.printQR(data.qrData, {
        size: 8,
        model: 2,
        error: 'M',
      });
    }

    printer.newLine();

    // Feed y corte
    printer.cut();

    const success = await printer.execute();
    if (!success) {
      return { ok: false, error: 'The printer did not respond to the command' };
    }

    return { ok: true };
  } catch (err: any) {
    log('error', 'receipt_print_failed');
    return { ok: false, error: 'Printing failed. Check the approved device configuration and connection.' };
  }
}

// ─── Opening de Gaveta ──────────────────────────────────────────────────────

export async function openCashDrawer(config: PrinterConfig): Promise<PrintResult> {
  try {
    const printer = await createPrinterInstance(config);

    // Pulso estándar ESC/POS para gaveta (pin 2 del conector)
    // \x1B\x70 = ESC p | \x00 = pin 2 | \x19\xFA = pulso on/off time
    printer.raw(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
    await printer.execute();

    return { ok: true };
  } catch (err: any) {
    log('error', 'cash_drawer_open_failed');
    return { ok: false, error: 'Drawer operation failed. Check the approved printer connection.' };
  }
}

// ─── Registro de Handlers IPC ────────────────────────────────────────────────

export function setupPrinterHandlers(getConfig: () => PrinterConfig): void {
  handleTrustedIpc(IPC_HANDLERS.PRINT_TICKET, async (_event, data: TicketData) => {
    return printTicket(getConfig(), data);
  });

  handleTrustedIpc(IPC_HANDLERS.OPEN_DRAWER, async () => {
    return openCashDrawer(getConfig());
  });

  console.log('[Printer] Handlers IPC registrados ✓');
}
