# ZAIPOS Deployments

Per-instance deployment configuration for ZAIPOS using Docker Compose hosts such as Dokploy. Production secrets never live in this repository; hosting infrastructure injects them at build/deploy time.

## Structure

```text
deployments/
├── _template/
│   └── docker-compose.yml
└── instances/
    └── demo-zaipos/
        └── docker-compose.yml
```

## Add an Instance

```bash
cp -r deployments/_template deployments/instances/client-name
```

Edit `docker-compose.yml` and replace the placeholder image/container names with the intended instance identifier.

## Repository Source

Use:

```text
https://github.com/MuhamedZanabal/ZAIPOS
```

## Required Build Variables

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase public client key |
| `APP_PORT` | Host port mapped to container port 80 |

`VITE_*` values are build-time frontend variables and become part of the compiled client bundle. Never place service-role secrets in them.

## Bahrain Deployment Baseline

After deployment, verify:

- ZAIPOS branding;
- English UI;
- BHD with three decimal places;
- Bahrain VAT configuration;
- +973 phone conventions;
- Cash, Card, BenefitPay, and Bank Transfer payment terminology;
- Physical POS, Tables, Talabat, WhatsApp, and In-house Delivery channels.

## Example Instance

| Instance | Default example port |
|---|---:|
| `demo-zaipos` | 3010 |

Legacy instance names and old upstream repository references are not supported deployment configuration.
