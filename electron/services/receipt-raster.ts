/**
 * Bilingual (Arabic/English) receipts for ESC/POS printers.
 *
 * ESC/POS text mode cannot shape Arabic, so the receipt is laid out as HTML
 * (Chromium does Arabic shaping and bidi with the bundled Noto Sans Arabic
 * font), captured as a bitmap and sent as GS v 0 raster image data. Callers
 * fall back to English text mode when rendering fails.
 */
import type { TicketData } from "../types.js";
import { buildReceiptTextLines, formatBhdReceiptAmount, receiptDocumentTitle } from "./receipt-format.js";

export const RECEIPT_AR: Record<string, string> = {
  "RECEIPT": "إيصال",
  "SIMPLIFIED TAX INVOICE": "فاتورة ضريبية مبسطة",
  "TAX INVOICE": "فاتورة ضريبية",
  "VAT Reg. No (TRN)": "رقم التسجيل الضريبي",
  "Invoice": "رقم الفاتورة",
  "Receipt": "رقم الإيصال",
  "Date": "التاريخ",
  "Cashier": "الكاشير",
  "Customer": "العميل",
  "Customer VAT No": "الرقم الضريبي للعميل",
  "Subtotal": "المجموع الفرعي",
  "Discount": "الخصم",
  "VAT": "ضريبة القيمة المضافة",
  "Tip": "الإكرامية",
  "TOTAL (incl. VAT)": "الإجمالي شامل الضريبة",
  "TOTAL": "الإجمالي",
  "Payment methods": "طرق الدفع",
  "Cash": "نقدًا", "Card": "بطاقة", "BenefitPay": "بنفت باي", "Bank Transfer": "تحويل بنكي",
  "REPRINT": "نسخة مكررة",
  "Thank you for your business!": "شكرًا لزيارتكم!",
};

/** Printable width in dots for common paper: 80 mm → 576, 58 mm → 384. */
export function receiptDotWidth(charWidth: number): number {
  return charWidth <= 32 ? 384 : 576;
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function methodLabel(method: string): string {
  const m = method.trim().toLowerCase();
  if (m === "cash") return "Cash";
  if (m === "card") return "Card";
  if (m === "qr" || m === "benefitpay") return "BenefitPay";
  if (m === "transfer" || m === "bank transfer") return "Bank Transfer";
  return method;
}

/** Self-contained HTML (inline font, no network) for one receipt at `dotWidth` CSS pixels. */
export function buildBilingualReceiptHtml(data: TicketData, dotWidth: number, fontBase64?: { regular: string; bold: string }): string {
  // Reuse the text formatter for validation and the exact date string.
  const textLines = buildReceiptTextLines(data, 42);
  const dateLine = textLines.find((l) => /#/.test(l)) ?? "";
  const date = dateLine.replace(/^.*?#\S+\s+/, "");
  const title = receiptDocumentTitle(data);
  const row = (en: string, value: string, opts: { bold?: boolean; big?: boolean } = {}) =>
    `<tr class="${opts.bold ? "b" : ""}${opts.big ? " big" : ""}"><td class="lbl"><div>${esc(en)}</div><div class="ar" dir="rtl" lang="ar">${esc(RECEIPT_AR[en] ?? "")}</div></td><td class="val" dir="ltr">${esc(value)}</td></tr>`;
  const vat = data.vatNumber?.trim();
  const items = data.items.map((item) => {
    const qty = Number.isInteger(item.quantity) ? String(item.quantity) : item.quantity.toFixed(3);
    return `<tr><td class="item" dir="ltr">${esc(qty)} × <bdi>${esc(item.name)}</bdi><div class="sub">@ ${esc(formatBhdReceiptAmount(item.unitPrice))}${(item.taxRate ?? 0) > 0 ? ` · VAT ${item.taxRate}%` : ""}${(item.discountAmount ?? 0) > 0 ? ` · -${esc(formatBhdReceiptAmount(item.discountAmount ?? 0))}` : ""}</div></td><td class="val">${esc(formatBhdReceiptAmount(item.total))}</td></tr>`;
  }).join("");
  const rates = Array.from(new Set(data.items.map((i) => i.taxRate ?? 0).filter((r) => r > 0)));
  const fontFace = fontBase64
    ? `@font-face{font-family:"ReceiptArabic";src:url(data:font/woff2;base64,${fontBase64.regular}) format("woff2");font-weight:400}@font-face{font-family:"ReceiptArabic";src:url(data:font/woff2;base64,${fontBase64.bold}) format("woff2");font-weight:700}`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFace}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:${dotWidth}px;background:#fff;color:#000}
body{font:22px/1.25 "ReceiptArabic","Noto Sans Arabic",sans-serif;padding:4px 6px 16px}
.c{text-align:center}.h1{font-size:28px;font-weight:700}.title{font-size:26px;font-weight:700;border:2px solid #000;margin:8px 0;padding:4px}
table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:2px 0}.val{text-align:right;white-space:nowrap;padding-left:8px}
.ar{font-size:20px}.b td{font-weight:700}.big td{font-size:28px}.sub{font-size:18px}hr{border:0;border-top:2px dashed #000;margin:6px 0}
</style></head><body>
<div class="c h1" dir="auto">${esc(data.businessName)}</div>
${data.branchName ? `<div class="c" dir="auto">${esc(data.branchName)}</div>` : ""}
${data.address ? `<div class="c" dir="auto">${esc(data.address)}</div>` : ""}
${data.phone ? `<div class="c">Tel: ${esc(data.phone)}</div>` : ""}
${data.isReprint ? `<div class="c b">*** REPRINT · ${RECEIPT_AR.REPRINT} ***</div>` : ""}
<div class="c title">${esc(title)}<div dir="rtl" lang="ar">${esc(RECEIPT_AR[title])}</div></div>
<table>
${vat ? row("VAT Reg. No (TRN)", vat) : ""}
${row(vat ? "Invoice" : "Receipt", `#${data.ticketNumber}`)}
${row("Date", date)}
${data.cashierName ? row("Cashier", data.cashierName) : ""}
${data.customerName ? row("Customer", data.customerName) : ""}
${data.customerVatNumber?.trim() ? row("Customer VAT No", data.customerVatNumber.trim()) : ""}
</table><hr><table>${items}</table><hr><table>
${row("Subtotal", formatBhdReceiptAmount(data.subtotal))}
${data.discountTotal > 0 ? row("Discount", `-${formatBhdReceiptAmount(data.discountTotal)}`) : ""}
${data.taxTotal > 0 ? row("VAT", formatBhdReceiptAmount(data.taxTotal)).replace(">VAT<", `>VAT${rates.length === 1 ? ` ${rates[0]}%` : ""}<`) : ""}
${data.tipAmount > 0 ? row("Tip", formatBhdReceiptAmount(data.tipAmount)) : ""}
${row(data.taxTotal > 0 ? "TOTAL (incl. VAT)" : "TOTAL", formatBhdReceiptAmount(data.total), { bold: true, big: true })}
</table>
${data.payments.length ? `<hr><table>${data.payments.map((p) => row(methodLabel(p.method), formatBhdReceiptAmount(p.amount))).join("")}</table>` : ""}
${data.notes ? `<hr><div class="c" dir="auto">${esc(data.notes)}</div>` : ""}
<div class="c" style="margin-top:8px">Thank you for your business!<div dir="rtl" lang="ar">${RECEIPT_AR["Thank you for your business!"]}</div></div>
</body></html>`;
}

/**
 * Converts a BGRA/RGBA bitmap to ESC/POS `GS v 0` raster commands (1 bit per dot,
 * MSB = leftmost). Pixels darker than `threshold` (0-255 luminance) print black.
 * Emitted in bands so printers with small buffers keep up.
 */
export function bitmapToEscPosRaster(width: number, height: number, pixels: Uint8Array, opts: { bgra?: boolean; threshold?: number; band?: number } = {}): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new RangeError("Invalid bitmap size");
  if (pixels.length < width * height * 4) throw new RangeError("Bitmap buffer is too small");
  const threshold = opts.threshold ?? 160;
  const band = Math.max(1, Math.min(opts.band ?? 128, 2047));
  const bytesPerRow = Math.ceil(width / 8);
  const [ri, bi] = opts.bgra ? [2, 0] : [0, 2];
  const chunks: Buffer[] = [Buffer.from([0x1b, 0x40])]; // ESC @ initialise
  for (let top = 0; top < height; top += band) {
    const rows = Math.min(band, height - top);
    const out = Buffer.alloc(8 + bytesPerRow * rows);
    out.set([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < width; x++) {
        const i = ((top + y) * width + x) * 4;
        const alpha = pixels[i + 3] / 255;
        const lum = (0.299 * pixels[i + ri] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + bi]) * alpha + 255 * (1 - alpha);
        if (lum < threshold) out[8 + y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    chunks.push(out);
  }
  return Buffer.concat(chunks);
}

/** Height of the printed content: index of the last row with any dark pixel, plus one (0 when blank). */
export function contentHeight(width: number, height: number, pixels: Uint8Array, bgra = false, threshold = 160): number {
  const [ri, bi] = bgra ? [2, 0] : [0, 2];
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * pixels[i + ri] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + bi];
      if (pixels[i + 3] > 0 && lum < threshold) return y + 1;
    }
  }
  return 0;
}
