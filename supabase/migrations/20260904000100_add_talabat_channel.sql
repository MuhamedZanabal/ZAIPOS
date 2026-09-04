-- Bahrain-native delivery ecosystem: add Talabat without deleting historical enum values.
-- PostgreSQL enum values are append-only here to preserve existing rows and migration safety.
ALTER TYPE public.sales_channel ADD VALUE IF NOT EXISTS 'talabat';
