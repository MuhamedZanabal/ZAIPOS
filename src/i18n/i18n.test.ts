import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { translate, useLanguageStore, useT } from "./index";
import { AR } from "./ar";

describe("bilingual UI", () => {
  beforeEach(() => act(() => useLanguageStore.getState().setLanguage("en")));

  it("switches document direction and language for Arabic", () => {
    act(() => useLanguageStore.getState().setLanguage("ar"));
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar-BH");
    act(() => useLanguageStore.getState().setLanguage("en"));
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("translates known strings and falls back to English", () => {
    expect(translate("Complete sale", "ar")).toBe("إتمام البيع");
    expect(translate("Some untranslated label", "ar")).toBe("Some untranslated label");
    expect(translate("Complete sale", "en")).toBe("Complete sale");
  });

  it("useT re-renders on language change", () => {
    const { result } = renderHook(() => useT());
    expect(result.current("Cash")).toBe("Cash");
    act(() => useLanguageStore.getState().setLanguage("ar"));
    expect(result.current("Cash")).toBe("نقدًا");
  });

  it("every Arabic entry is non-empty and actually Arabic", () => {
    for (const [en, ar] of Object.entries(AR)) {
      expect(ar.trim(), en).not.toBe("");
      expect(/[\u0600-\u06FF]/.test(ar), en).toBe(true);
    }
  });
});
