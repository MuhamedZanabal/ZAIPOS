# ZAIPOS Database Schema

ZAIPOS uses PostgreSQL through Supabase with tenant-scoped Row Level Security.

## Core domains

- tenants and branches
- users and roles
- products, categories, prices, modifiers, and recipes
- inventory centers, stock, movements, transfers, and purchases
- sales, sale items, payments, returns, and cash sessions
- tables, kitchen orders, delivery orders, and digital marketplace orders
- customers, loyalty, suppliers, employees, shifts, expenses, and reports
- AI/WhatsApp configuration and knowledge data

## Bahrain baseline

New tenants default to BHD, the en-BH locale, and a 10% standard VAT baseline. Bahrain phone/address conventions and Bahrain-relevant payment/channel labels are used by active application surfaces.

Historical database enum values or columns may remain where PostgreSQL/data compatibility requires them, but they are not active foreign-market integrations.
