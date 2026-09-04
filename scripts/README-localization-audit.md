# ZAIPOS Bahrain localization audit

`node scripts/audit-localization.mjs` is the repository-wide text gate for the ZAIPOS/Bahrain cutover. It checks active text surfaces for legacy POS S360T branding, the old upstream repository, COP/es-CO defaults, removed foreign marketplace integrations, known Spanish UI residue, package identity, and Bahrain invariants.

Historical Supabase migrations and generated Supabase types may retain compatibility enum values that cannot be safely deleted from PostgreSQL. Runtime/UI/integration surfaces must not activate or expose those legacy values.
