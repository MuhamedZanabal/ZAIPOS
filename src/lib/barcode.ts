/**
 * Barcode encoders for shelf/product labels: EAN-13 and Code 128 (B/C),
 * rendered as SVG (print / PDF) or as native ESC/POS barcode commands.
 * Output is a module string: "1" = bar, "0" = space, one char per module.
 */

const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const EAN_G = EAN_L.map((p) => [...p].reverse().map((b) => (b === "1" ? "0" : "1")).join(""));
const EAN_R = EAN_L.map((p) => [...p].map((b) => (b === "1" ? "0" : "1")).join(""));
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new RangeError("EAN-13 needs 12 digits before the check digit");
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function encodeEan13(code: string): string {
  if (!isValidEan13(code)) throw new RangeError(`Invalid EAN-13: ${code}`);
  const parity = EAN_PARITY[Number(code[0])];
  let left = "";
  for (let i = 1; i <= 6; i += 1) left += (parity[i - 1] === "L" ? EAN_L : EAN_G)[Number(code[i])];
  let right = "";
  for (let i = 7; i <= 12; i += 1) right += EAN_R[Number(code[i])];
  return `101${left}01010${right}101`;
}

// Code 128 bar/space widths for values 0..106 (106 = STOP, 13 modules incl. final bar).
const C128 = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112",
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;

function widthsToModules(widths: string): string {
  return [...widths].map((w, i) => (i % 2 === 0 ? "1" : "0").repeat(Number(w))).join("");
}

/** Code 128 values for `text`: subset C for runs of 4+ digit pairs, B otherwise (ASCII 32–126). */
export function code128Values(text: string): number[] {
  if (!text.length || /[^\x20-\x7e]/.test(text)) throw new RangeError("Code 128 labels support printable ASCII only");
  const values: number[] = [];
  let mode: "B" | "C" | null = null;
  let i = 0;
  const digitRun = (from: number) => { let n = 0; while (from + n < text.length && /\d/.test(text[from + n])) n += 1; return n; };
  while (i < text.length) {
    const run = digitRun(i);
    const useC = run >= 4 && (i === 0 || i + run === text.length || run >= 6);
    if (useC) {
      const pairs = Math.floor(run / 2);
      if (mode !== "C") { values.push(mode === null ? START_C : CODE_C); mode = "C"; }
      for (let p = 0; p < pairs; p += 1) { values.push(Number(text.slice(i, i + 2))); i += 2; }
      continue;
    }
    if (mode !== "B") { values.push(mode === null ? START_B : CODE_B); mode = "B"; }
    values.push(text.charCodeAt(i) - 32);
    i += 1;
  }
  const checksum = values.reduce((acc, v, idx) => acc + v * (idx === 0 ? 1 : idx), 0) % 103;
  return [...values, checksum, 106];
}

export function encodeCode128(text: string): string {
  return code128Values(text).map((v) => widthsToModules(C128[v])).join("");
}

export type BarcodeKind = "ean13" | "code128";

/** EAN-13 when the code is a valid EAN-13, otherwise Code 128. */
export function pickBarcodeKind(code: string): BarcodeKind {
  return isValidEan13(code) ? "ean13" : "code128";
}

export function encodeBarcode(code: string, kind = pickBarcodeKind(code)): string {
  return kind === "ean13" ? encodeEan13(code) : encodeCode128(code);
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Standalone SVG with a quiet zone and the human-readable code under the bars. */
export function barcodeSvg(code: string, opts: { moduleWidth?: number; height?: number; kind?: BarcodeKind } = {}): string {
  const modules = encodeBarcode(code, opts.kind);
  const mw = opts.moduleWidth ?? 2;
  const h = opts.height ?? 60;
  const quiet = 10 * mw;
  const width = modules.length * mw + quiet * 2;
  let rects = "";
  for (let i = 0; i < modules.length; ) {
    if (modules[i] === "1") {
      let j = i; while (j < modules.length && modules[j] === "1") j += 1;
      rects += `<rect x="${quiet + i * mw}" y="0" width="${(j - i) * mw}" height="${h}"/>`;
      i = j;
    } else i += 1;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h + 16}" width="${width}" height="${h + 16}" role="img" aria-label="${xml(code)}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g><text x="${width / 2}" y="${h + 13}" font-family="monospace" font-size="12" text-anchor="middle">${xml(code)}</text></svg>`;
}

/**
 * ESC/POS bytes for one label: name, price, then the printer's native barcode
 * (GS k: m=67 EAN13, m=73 CODE128 with "{B" code set). Ends with a feed+cut.
 */
export function escPosLabel(label: { name: string; priceText: string; code: string; copies?: number }): Uint8Array {
  const kind = pickBarcodeKind(label.code);
  const ascii = (s: string) => [...s.replace(/[^\x20-\x7e]/g, "?")].map((c) => c.charCodeAt(0));
  const one: number[] = [
    0x1b, 0x40, // init
    0x1b, 0x61, 0x01, // center
    ...ascii(label.name.slice(0, 32)), 0x0a,
    0x1b, 0x45, 0x01, ...ascii(label.priceText), 0x1b, 0x45, 0x00, 0x0a,
    0x1d, 0x68, 80, // barcode height
    0x1d, 0x77, 2, // module width
    0x1d, 0x48, 0x02, // HRI below
  ];
  if (kind === "ean13") {
    const data = ascii(label.code.slice(0, 12));
    one.push(0x1d, 0x6b, 67, data.length, ...data);
  } else {
    const data = [0x7b, 0x42, ...ascii(label.code)];
    if (data.length > 255) throw new RangeError("Barcode too long for ESC/POS");
    one.push(0x1d, 0x6b, 73, data.length, ...data);
  }
  one.push(0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00); // feed + partial cut
  const copies = Math.max(1, Math.min(100, Math.floor(label.copies ?? 1)));
  const out = new Uint8Array(one.length * copies);
  for (let c = 0; c < copies; c += 1) out.set(one, c * one.length);
  return out;
}
