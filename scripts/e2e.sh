#!/bin/sh
set -eu

compose_file=docker-compose.e2e.yml
cleanup() {
  docker compose -f "$compose_file" down --volumes --remove-orphans
  # Sandboxes run as root, so remove their bind-mounted files as root as well.
  docker run --rm -v /tmp/opencode:/work alpine:3.21 rm -rf /work/subpolar-e2e-workspaces
}
trap cleanup EXIT INT TERM

mkdir -p /tmp/opencode/subpolar-e2e-workspaces
docker compose -f "$compose_file" up --build --detach
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3100/api/health >/dev/null; then
    if SUBPOLAR_E2E_URL=http://127.0.0.1:3100 \
      SUBPOLAR_E2E_EMAIL=e2e@example.com \
      SUBPOLAR_E2E_PASSWORD=e2e-password-that-is-long-enough \
      bun test tests/e2e.test.ts; then
      exit 0
    fi
    docker compose -f "$compose_file" logs
    exit 1
  fi
  sleep 1
done

docker compose -f "$compose_file" logs
exit 1
