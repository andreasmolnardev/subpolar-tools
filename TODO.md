# Remaining BUILD.md Work

This file tracks requirements from `BUILD.md` that are not yet fully implemented.

## Provider Management

- [x] Support long-lived supervised MCP stdio processes, including environment variables and configured startup behavior.
- [x] Add provider headers, custom authentication configuration, and credential rotation in the UI.
- [x] Show previous versus current MCP schema snapshots as a readable diff.
- [x] Show affected agent profiles and project roles on provider detail pages.
- [x] Add provider disable/enable controls and unavailable/changed filters.
- [x] Add OpenAPI schema upload or inline schema configuration rather than URL-only discovery.

## Agent Profiles

- [x] Add edit and delete controls for agent profiles in the UI.
- [x] Add edit controls for existing adapters, including exposed tool renaming and descriptions.
- [x] Surface adapter-schema validation results in the UI.
- [x] Use confirmation dialogs rather than browser prompts for token, adapter, and profile destruction.
- [x] Add explicit OpenAPI/MCP endpoint URLs and contract download/copy actions in the UI.

## Projects And Roles

- [x] Add project deletion confirmation and project settings editing.
- [x] Add role editing and deletion controls.
- [x] Allow roles to select external integration tools and role-specific adapters.
- [x] Add project repository selection flows for Gitea, GitHub, and GitLab.
- [x] Add project-level Git credential rotation and pull-request creation controls in the UI.
- [x] Configure sandbox environment variables, mounted secrets, shared package caches, and isolated home directories.

## Workspaces And Sandboxes

- [x] Show worktree state, last activity, resource usage, and formatted Git status in workspace administration.
- [x] Add workspace diff view, sandbox logs, and a distinct release workflow.
- [x] Enforce configured shell command timeouts from sandbox policy instead of the global fixed timeout.
- [x] Add network, mount, cache, and isolation integration tests proving one workspace cannot access another.
- [x] Add role-controlled workspace creation and cleanup access through project-facing harness contracts.

## Git Workflow

- [x] Add safe Git commit, fetch, pull, push, and pull-request controls to the administrative workspace UI.
- [x] Configure Git author identity and remote credentials for workspace commits and pushes.
- [x] Add Git-provider pull-request creation UI and provider-specific error/status reporting.

## Users And Authorization

- [x] Add platform access grants so normal users can be assigned selected agent profiles and projects.
- [x] Add user password-reset controls and detailed session review to the Users administration page.
- [x] Add audit-event filtering, actor/resource detail, and security-event retention policy.
- [x] Add an optional persistent-sign-in setting with configurable session lifetime.
- [x] Replace in-memory rate limiting with durable, deployment-safe rate limits.
- [x] Configure production SMTP and disable development email-token logging by default outside development.

## Verification And Operations

- [x] Add unit tests for adapter mapping, credential encryption, authorization, schema changes, and path isolation.
- [x] Add integration tests for OpenAPI, MCP HTTP, MCP command/stdio, and workspace tool contracts.
- [x] Add Docker end-to-end tests for worktree creation, sandbox lifecycle, and cross-workspace isolation.
- [x] Add CI to run formatting, type checking, tests, image build, and integration tests.
- [x] Add deployment documentation for backups, secret rotation, SMTP, Git provider setup, and Docker socket security.
