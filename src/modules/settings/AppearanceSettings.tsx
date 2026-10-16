import { translate as tx, useLanguageStore } from "@/i18n";
export default function AppearanceSettings() {
  useLanguageStore((state) => state.language); // re-render on language change
  return (
    <div className="space-y-4 max-w-md">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{tx("Appearance")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {tx("ZAIPOS uses the brand's light glassmorphism design. Dark mode is disabled to maintain the system’s visual consistency.")}
        </p>
      </div>
    </div>
  )
}
