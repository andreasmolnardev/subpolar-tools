#!/bin/sh
set -eu
: "${SUBPOLAR_ADMIN_EMAIL:?SUBPOLAR_ADMIN_EMAIL is required}"
: "${SUBPOLAR_ADMIN_PASSWORD:?SUBPOLAR_ADMIN_PASSWORD is required}"
: "${SUBPOLAR_SECRET_KEY:?SUBPOLAR_SECRET_KEY is required}"
pocketbase superuser upsert "$SUBPOLAR_ADMIN_EMAIL" "$SUBPOLAR_ADMIN_PASSWORD" --dir /app/pb_data
if [ "${SUBPOLAR_LOG_EMAIL_TOKENS:-false}" = "true" ]; then
  # PocketBase --dev writes outgoing email content, including verification/reset links, to container logs.
  pocketbase serve --dev --http=127.0.0.1:8090 --dir /app/pb_data &
else
  pocketbase serve --http=127.0.0.1:8090 --dir /app/pb_data &
fi
until curl -fsS http://127.0.0.1:8090/api/health >/dev/null; do sleep 1; done
exec bun /app/services/api/src/server.ts
