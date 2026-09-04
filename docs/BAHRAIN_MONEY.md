# Bahrain Money Model

ZAIPOS formats Bahrain monetary values as BHD with three decimal places using the `en-BH` locale.

Application logic must not assume zero-decimal currencies. Cash shortcuts, receipts, reports, exports, dashboards and order totals must use the shared Bahrain-aware formatting layer rather than hard-coded currency symbols or locale-specific number formats.
