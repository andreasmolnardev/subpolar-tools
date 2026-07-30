# Subpolar Tools

Subpolar Tools is a Bun, Hono, TypeScript, React, shadcn-style administration platform for model- and harness-agnostic tool calling and isolated coding workspaces.

## Run

1. Copy `.env.example` to `.env` and replace every secret.
2. Start the complete service with `docker compose up --build`.
3. Open `http://localhost:3000` and sign in with `SUBPOLAR_ADMIN_EMAIL` and `SUBPOLAR_ADMIN_PASSWORD`.

The main container starts PocketBase on the loopback interface and the Hono application on port 3000. PocketBase data is persisted in the `subpolar-data` volume.

`SUBPOLAR_LOG_EMAIL_TOKENS=true` starts PocketBase in development mail mode, which prints password-reset and email-verification links/tokens to `docker compose logs`. It defaults to `false`; configure SMTP in PocketBase for production.

For local UI/API development, run `bun install` followed by `bun run dev`. A separately running PocketBase instance must be available at `PB_URL`.

Run `bun test` for the test suite. With a running deployment, execute the session integration test with `SUBPOLAR_TEST_URL`, `SUBPOLAR_TEST_EMAIL`, and `SUBPOLAR_TEST_PASSWORD` set, then run `bun run test:integration`.

## Architecture

- The React administrative application uses only Hono's `/api` management API.
- PocketBase is the bundled persistent identity and configuration store.
- `/api/v1/resolve/:tool` is a separate stateless, bearer-token-only harness endpoint. It never accepts an administrator session.
- Provider credentials are centrally stored encrypted at rest using `SUBPOLAR_SECRET_KEY`; agent credentials are hash-only and shown once at creation.
- Administrative workspace creation creates a unique opaque handle and worktree in the `Stopped` state. A role credential with `workspace.create` starts a sandbox when it creates a worktree; administrators may start any stopped sandbox manually. Sandbox children never receive the Docker socket.

## Harness APIs

`POST /api/v1/resolve/:tool` invokes one exposed provider operation with an `spat_` agent credential. The adapter validates the exposed input, applies field mappings and fixed arguments, and maps the provider response before returning it.

`spws_` role credentials access only a known opaque workspace handle through `/api/v1/workspaces/:handle/...`. The available filesystem, shell, and Git operations are individually checked against the role capabilities. There is deliberately no workspace enumeration API for these credentials.

The main container has Docker socket access exclusively because it is the sandbox manager. Treat this container as privileged infrastructure and do not expose its management API without authentication.
