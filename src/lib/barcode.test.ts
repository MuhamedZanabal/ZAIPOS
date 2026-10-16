import { describe, expect, it } from "vitest";
import { barcodeSvg, code128Values, ean13CheckDigit, encodeCode128, encodeEan13, escPosLabel, isValidEan13, pickBarcodeKind } from "./barcode";

describe("EAN-13", () => {
  it("computes check digits", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1);
    expect(ean13CheckDigit("629000000077")).toBe(1);
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });
  it("encodes 95 modules with guards and known pattern", () => {
    const m = encodeEan13("4006381333931");
    expect(m).toHaveLength(95);
    expect(m.startsWith("101")).toBe(true);
    expect(m.slice(45, 50)).toBe("01010");
    expect(m.endsWith("101")).toBe(true);
    // first digit 4 → parity LGLLGG; digit 0 in L = 0001101
    expect(m.slice(3, 10)).toBe("0001101");
    // digit 0 in G = 0100111
    expect(m.slice(10, 17)).toBe("0100111");
  });
});

describe("Code 128", () => {
  it("uses subset B for text and the reference checksum", () => {
    // 104 + 48·1 + 42·2 + 42·3 + 17·4 + 18·5 + 19·6 + 35·7 = 879 ≡ 55 (mod 103)
    const v = code128Values("PJJ123C");
    expect(v[0]).toBe(104);
    expect(v.at(-2)).toBe(55);
    expect(v.at(-1)).toBe(106);
  });
  it("uses subset C for long digit runs", () => {
    expect(code128Values("123456")).toEqual([105, 12, 34, 56, (105 + 12 + 34 * 2 + 56 * 3) % 103, 106]);
  });
  it("every symbol is 11 modules and stop is 13", () => {
    const m = encodeCode128("SKU-42");
    expect((m.length - 13) % 11).toBe(0);
    expect(m.endsWith("11")).toBe(true);
  });
  it("rejects non-ASCII", () => expect(() => encodeCode128("قهوة")).toThrow());
});

describe("rendering", () => {
  it("picks EAN-13 only for valid codes", () => {
    expect(pickBarcodeKind("6290000000771")).toBe("ean13");
    expect(pickBarcodeKind("6290000000777")).toBe("code128");
  });
  it("produces an SVG with escaped human-readable text", () => {
    const svg = barcodeSvg("A<B");
    expect(svg).toContain("<svg");
    expect(svg).toContain("A&#60;B");
    expect(svg).not.toContain("A<B");
  });
  it("emits native ESC/POS barcode commands", () => {
    const ean = escPosLabel({ name: "Karak tea", priceText: "BHD 0.200", code: "6290000000771" });
    const i = ean.findIndex((b, k) => b === 0x1d && ean[k + 1] === 0x6b);
    expect([...ean.slice(i, i + 4)]).toEqual([0x1d, 0x6b, 67, 12]);
    const c128 = escPosLabel({ name: "x", priceText: "y", code: "SKU-1", copies: 2 });
    const j = c128.findIndex((b, k) => b === 0x1d && c128[k + 1] === 0x6b);
    expect([...c128.slice(j, j + 6)]).toEqual([0x1d, 0x6b, 73, 7, 0x7b, 0x42]);
    expect(c128.length % 2).toBe(0);
  });
});
