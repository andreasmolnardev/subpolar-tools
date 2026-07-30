#!/bin/sh
set -eu
: "${SUBPOLAR_ADMIN_EMAIL:?SUBPOLAR_ADMIN_EMAIL is required}"
: "${SUBPOLAR_ADMIN_PASSWORD:?SUBPOLAR_ADMIN_PASSWORD is required}"
: "${SUBPOLAR_SECRET_KEY:?SUBPOLAR_SECRET_KEY is required}"
pocketbase superuser upsert "$SUBPOLAR_ADMIN_EMAIL" "$SUBPOLAR_ADMIN_PASSWORD" --dir /app/pb_data
pocketbase serve --http=127.0.0.1:8090 --dir /app/pb_data &
until curl -fsS http://127.0.0.1:8090/api/health >/dev/null; do sleep 1; done
exec bun /app/src/server.ts
