# Operations

## Backups and recovery

Back up the `subpolar-data` Docker volume while the service is stopped, or use a filesystem-consistent volume snapshot. Back up `subpolar-workspaces` only when retaining active worktrees is required; released workspaces are disposable. Restore both volumes before starting the service.

## Secrets and email

Set a high-entropy `SUBPOLAR_SECRET_KEY` before the first deployment. It encrypts provider and Git credentials. Keep the key in a secret manager and back it up separately from PocketBase data. Changing it makes existing encrypted credentials unreadable; rotate by replacing credentials, then deploy with the new key.

`SUBPOLAR_LOG_EMAIL_TOKENS` defaults to `false`. Configure SMTP in PocketBase for production password-reset and verification mail. Enable token logging only for a local development deployment.

## Git providers

Configure a project Git integration with a least-privilege token that can create pull requests for the selected repository. Set a repository URL and provider type before creating workspaces. Use a separate identity for Git commits where required by your provider.

## Docker socket

The main Subpolar container manages sandbox containers and consequently has access to `/var/run/docker.sock`. Do not expose that socket, the PocketBase port, or an unauthenticated management API. Run Subpolar on a dedicated host or isolate the Docker daemon, restrict administrator access, and use images from trusted registries.

Set `SUBPOLAR_WORKSPACE_ROOT` to an absolute, Subpolar-owned host directory. Docker Compose mounts it at the identical path in the manager so child sandbox bind mounts resolve to the intended worktree. Do not point it at a shared home directory or any path containing unrelated repositories.
