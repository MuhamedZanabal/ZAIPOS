# ZAIPOS Hardware Integration

Hardware integration is provided through the Electron desktop runtime.

## Supported Device Classes

- ESC/POS-compatible thermal receipt printers
- Cash drawers triggered through compatible printer commands
- Barcode scanners acting as keyboard input
- Supported serial-port scanner workflows

## Receipt Printing

Printed receipts use the ZAIPOS receipt model and shared Bahrain currency formatting:

- BHD values with three decimal places
- English labels
- Bahrain business header/contact information configured by the merchant
- VAT breakdown when enabled
- Cash, Card, BenefitPay, or Bank Transfer payment labels

No printer template should contain the legacy product name, COP/dollar examples, or non-Bahrain tax terminology.

## Cash Drawer

The drawer should open only for flows that require it, normally cash checkout. A hardware failure after a successfully committed sale must not cause the sale to be retried or charged twice.

## Barcode Scanners

Keyboard-style scanners generally work without special drivers. Electron/serial integrations can be used for devices that expose a serial interface. Barcode lookup is a catalogue-assistance feature and must not fabricate product or pricing data.

## Configuration

Device-specific configuration is stored locally through Electron settings. Compatibility-sensitive internal storage identifiers can remain unchanged if renaming them would discard existing installed-device configuration.

## Failure Handling

Hardware is downstream of transaction persistence. If printing or drawer control fails after the database sale succeeds, ZAIPOS should report the hardware failure while preserving the completed transaction.

## Deployment Test Checklist

- print a BHD receipt;
- verify three decimal places;
- verify ZAIPOS branding;
- verify BenefitPay/Bank Transfer labels where applicable;
- test cash drawer behavior;
- scan a known barcode;
- disconnect/reconnect the printer and verify the sale is not duplicated.
