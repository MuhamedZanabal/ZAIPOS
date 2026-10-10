#!/usr/bin/env sh
# Install the ZAIPOS PostgreSQL compatibility extensions (pg_net, pg_cron, pgmq,
# supabase_vault SQL stubs) into a Linux PostgreSQL installation.
#
# The Windows installer bundles these files with its PostgreSQL runtime. On Linux
# the local service uses the system PostgreSQL, so they must be installed once,
# otherwise the migration chain stops with: extension "pg_net" is not available.
#
# Usage: sudo scripts/install-linux-postgres-compat.sh [path/to/pg_config]
set -eu
PG_CONFIG="${1:-${PG_CONFIG:-pg_config}}"
if ! command -v "$PG_CONFIG" >/dev/null 2>&1; then
  for candidate in /usr/lib/postgresql/*/bin/pg_config; do
    [ -x "$candidate" ] && PG_CONFIG="$candidate"
  done
fi
command -v "$PG_CONFIG" >/dev/null 2>&1 || { echo "pg_config not found; pass its path" >&2; exit 1; }
SHAREDIR="$("$PG_CONFIG" --sharedir)"
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/local-service/postgres-compat/extension"
[ -d "$SOURCE" ] || { echo "missing $SOURCE" >&2; exit 1; }
install -d "$SHAREDIR/extension"
for file in "$SOURCE"/*.control "$SOURCE"/*.sql; do
  install -m 0644 "$file" "$SHAREDIR/extension/"
  echo "installed $(basename "$file") -> $SHAREDIR/extension/"
done
echo "PostgreSQL compatibility extensions installed for $("$PG_CONFIG" --version)."
