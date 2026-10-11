import { Languages } from "lucide-react";
import { useLanguageStore } from "@/i18n";

/** Compact English/Arabic switch; the choice persists in localStorage and sets dir/lang on <html>. */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const { language, setLanguage } = useLanguageStore();
  const next = language === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      data-testid="language-toggle"
      className={`flex items-center gap-1.5 shrink-0 px-3 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 ${className}`}
      onClick={() => setLanguage(next)}
      aria-label={language === "ar" ? "Switch to English" : "التبديل إلى العربية"}
      lang={next === "ar" ? "ar" : "en"}
    >
      <Languages className="h-4 w-4" aria-hidden="true" />
      {next === "ar" ? "العربية" : "English"}
    </button>
  );
}
