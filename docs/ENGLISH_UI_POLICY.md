# UI Language Policy

ZAIPOS user-facing interface text is authored in English. English is the source language and the default.

Arabic is available as a second UI language (Sidebar → Language). Arabic strings live in `src/i18n/ar.ts`, keyed by the English source text; `translate()` / `useT()` fall back to English for any string not yet translated, so partial coverage never blanks a screen. Selecting Arabic sets `<html dir="rtl" lang="ar-BH">`.

Coverage today: navigation, POS register/search/ticket, payment dialog, cash register tabs and Z-report. Other screens still render English.

Receipts and tax invoices stay English (permitted by the NBR VAT regulations, which accept Arabic or English) because the ESC/POS text path cannot print Arabic glyphs; bilingual printed receipts need raster printing.

Persisted database enum values, migration history, machine identifiers and third-party protocol values are not user-facing language and may remain unchanged when compatibility requires them. Any such value must be mapped to English (or translated) before rendering.

The localization audit is the enforcement gate for known Spanish UI residue and legacy country/product markers.
