# Running the ZAIPOS local runtime on Linux

The Windows installer bundles PostgreSQL, the compatibility extensions, and the
local service. On Linux you set these up once, by hand:

1. Install PostgreSQL 17 server binaries (Debian/Ubuntu: `sudo apt install postgresql`).
2. Install the compatibility extensions (SQL stubs for pg_net, pg_cron, pgmq,
   supabase_vault) that the historical migration chain expects:

   ```sh
   sudo scripts/install-linux-postgres-compat.sh            # or pass /usr/lib/postgresql/17/bin/pg_config
   ```

   If you skip this step, startup fails with `extension "pg_net" is not available`.
3. Create the service root (the only approved Linux root) owned by the user that
   runs the service:

   ```sh
   sudo install -d -m 700 -o "$USER" /var/lib/zaipos
   ```

4. Build and start the service, with the PostgreSQL binaries on `PATH`:

   ```sh
   cargo build -p zaipos-local-service --release
   PATH=/usr/lib/postgresql/17/bin:$PATH ./target/release/zaipos-local-service
   ```

   The service provisions its own cluster on 127.0.0.1:55432, applies every
   migration, and writes `/var/lib/zaipos/desktop/server-profile.json`. Once
   `server-status.json` reports `READY`, the desktop app can connect.

5. Start the desktop app (`npm run build:electron:dir`, or `vite build --mode electron && npx electron .`).
   It picks up the server profile, and the first screen creates the owner, branch and register.
