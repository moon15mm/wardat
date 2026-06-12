#!/usr/bin/env bash
# Restore the Wardat PostgreSQL database from a gzipped pg_dump backup.
#
# Usage (run from the project root, e.g. /root/wardat):
#   bash scripts/restore-db.sh wardat-db-YYYYMMDD-HHMMSS.sql.gz
#
# WARNING: this OVERWRITES the current database with the backup contents.
# Take a fresh backup first (the panel's "نسخة احتياطية الآن") before restoring.
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "Usage: bash scripts/restore-db.sh <backup-file.sql.gz>"
  echo "Available backups:"; ls -1 backups/ 2>/dev/null || true
  exit 1
fi

# Allow passing just the filename (looked up under backups/) or a full path.
if [ ! -f "$FILE" ] && [ -f "backups/$FILE" ]; then
  FILE="backups/$FILE"
fi
if [ ! -f "$FILE" ]; then
  echo "Backup file not found: $FILE"; exit 1
fi

# Read DATABASE_URL from .env and strip the ?schema=... query (libpq rejects it).
DBURL=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"' )
DBURL="${DBURL%%\?*}"
if [ -z "$DBURL" ]; then echo "DATABASE_URL not found in .env"; exit 1; fi

echo "About to restore '$FILE' into the database. This OVERWRITES current data."
read -r -p "Type 'yes' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then echo "Aborted."; exit 1; fi

echo "Restoring..."
gunzip -c "$FILE" | psql "$DBURL"
echo "Done. Restart the app:  pm2 restart wardat-saas"
