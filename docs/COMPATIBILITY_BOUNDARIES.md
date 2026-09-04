# Compatibility Boundaries

Repository-wide localization does not require destructive changes to persisted protocol or database values when doing so risks existing installations.

Allowed compatibility boundaries include:

- existing internal payment storage buckets that are rendered as Bahrain-native labels;
- historical PostgreSQL enum values that cannot be safely removed from already-deployed databases;
- persisted local settings keys whose renaming would discard installed-device configuration.

These values must not appear as active legacy product branding, Spanish UI, COP/Colombia defaults, or active foreign marketplace integrations.
