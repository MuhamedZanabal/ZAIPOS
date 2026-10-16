import { create } from "zustand";
import { persist } from "zustand/middleware";
import { AR } from "./ar";

export type Language = "en" | "ar";

interface LanguageState { language: Language; setLanguage: (language: Language) => void }

export function applyDocumentLanguage(language: Language): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language === "ar" ? "ar-BH" : "en-BH";
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: "en",
      setLanguage: (language) => { applyDocumentLanguage(language); set({ language }); },
    }),
    { name: "zaipos.language", onRehydrateStorage: () => (state) => { if (state) applyDocumentLanguage(state.language); } },
  ),
);

/** Translate an English UI string into the active language (falls back to English). */
export function translate(text: string, language: Language = useLanguageStore.getState().language): string {
  return language === "ar" ? AR[text] ?? text : text;
}

/** React hook: `const t = useT(); t("Complete sale")`. Re-renders when the language changes. */
export function useT(): (text: string) => string {
  const language = useLanguageStore((s) => s.language);
  return (text: string) => translate(text, language);
}
