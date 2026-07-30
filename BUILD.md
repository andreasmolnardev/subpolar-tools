Add the web interface as an explicit product goal, but keep it separate from the stateless resolver and runtime layers.

# Subpolar Tools — Updated Goal-Oriented Implementation Plan

## Vision

Build **Subpolar Tools** as a model-agnostic and harness-agnostic tool-calling and workspace platform.

It should provide:

* centralized MCP and OpenAPI integrations;
* stateless agent authorization profiles;
* project-specific roles;
* isolated Git worktrees and workspace sandboxes;
* built-in filesystem, shell, and Git capabilities;
* an administrative web interface for configuring the platform.

Subpolar should provide the infrastructure behind a computer-like agent experience without initially owning the model loop, conversations, or agent runtime.

The architecture follows the original concept of aggregating tool providers, exposing selected tools through agent-specific profiles, and supporting parallel coding work through project worktrees. 

---

# Product surfaces

## Tool API layer

This is the harness-facing layer.

It exposes tools through:

* MCP;
* OpenAPI.

It contains the stateless resolver that:

```text
receives exposed tool call
→ loads caller profile
→ validates authorization
→ adapts input
→ invokes provider or workspace tool
→ adapts output
→ returns result
```

It must not depend on the web interface.

## Workspace layer

This owns:

* projects;
* Git repositories;
* worktrees;
* workspace handles;
* sandbox containers;
* filesystem access;
* shell execution;
* Git operations.

## Administrative web interface

The web UI is the main configuration and management interface for human administrators.

It should not execute the model loop or start agent conversations. It configures the tool and workspace infrastructure consumed by external harnesses.

---

# Web interface structure

Use a persistent sidebar with these primary sections:

```text
Dashboard
Tools
Agents
Projects
Users
Settings
```

The first release may omit the dashboard if needed, but **Tools**, **Agents**, and **Projects** are core requirements.

---

## Tools section

The sidebar should contain an **All Tools** entry.

The Tools section manages all centrally configured tool providers.

### All Tools page

Show:

* configured MCP providers;
* configured OpenAPI providers;
* provider availability;
* tool count;
* schema status;
* last successful connection;
* affected agents and project roles;
* warning state when a provider changed or became unavailable.

Useful filters:

```text
All
MCP
OpenAPI
Available
Changed
Unavailable
```

### Add tool provider

Administrators should be able to add:

#### MCP providers

Configure:

* display name;
* transport;
* server URL or command;
* authentication;
* environment variables where applicable;
* startup behavior;
* connection timeout.

After saving, Subpolar discovers the tools and schemas exposed by the MCP server.

#### OpenAPI providers

Configure:

* display name;
* base URL;
* OpenAPI schema;
* authentication;
* headers;
* timeout.

OpenAPI schemas are treated as explicitly configured and stable.

### Provider detail page

Show:

* connection configuration;
* credentials reference;
* provider status;
* discovered operations or MCP tools;
* current schema;
* previous MCP schema snapshot;
* schema changes;
* profiles using each tool;
* test connection action;
* refresh or rediscover action;
* disable provider action.

Credentials should be masked and stored centrally in Subpolar.

---

## Agents section

The sidebar should contain an **Agents** entry.

An agent profile is a stateless authorization and tool-presentation profile. It does not represent a running agent.

### Agent list

Show:

* profile name;
* description;
* enabled status;
* exposed tool count;
* provider health warnings;
* creation and modification timestamps.

### Agent editor

Administrators should be able to:

* create and delete profiles;
* enable or disable profiles;
* add provider-backed tools;
* rename tools;
* define the model-visible description;
* define the exposed input schema;
* map exposed input fields to provider fields;
* define fixed or hidden arguments;
* map provider output into the exposed output;
* preview the final MCP/OpenAPI tool contract;
* test the adapted tool;
* validate mappings against the current provider schema.

Example:

```text
Underlying provider tool:
searxng.query

Exposed to the model as:
web.search
```

The adapter is configured per agent profile rather than globally.

### Agent access credentials

The UI should support generating and revoking credentials for using an agent profile through MCP or OpenAPI.

Show:

* credential name;
* creation date;
* last used;
* status;
* revoke action.

The full secret should only be shown when created.

---

## Projects section

The sidebar should contain a **Projects** entry.

Projects own repositories, roles, workspaces, worktrees, and sandbox configuration.

### Project list

Show:

* project name;
* Git provider;
* repository;
* default branch;
* role count;
* active workspace count;
* project health.

### Create project

The project creation flow should include:

#### General

* project name;
* description;
* repository URL or repository selection;
* default branch.

#### Git provider

Choose:

* Gitea;
* GitHub;
* GitLab;
* generic Git remote;
* local-only repository.

Configure or select the corresponding Git provider credentials.

#### Default developer role

Include:

```text
☑ Create default developer role
```

When selected, Subpolar creates a practical role containing:

* filesystem read;
* filesystem write;
* filesystem search;
* shell execution;
* Git status;
* Git diff;
* Git log;
* Git branch;
* Git commit;
* Git fetch;
* Git pull;
* Git push;
* pull-request creation where supported.

Dangerous capabilities should remain disabled by default, including:

* force push;
* changing remotes;
* deleting remote branches;
* directly merging into the default branch.

#### Sandbox defaults

Configure:

* container image;
* CPU limit;
* memory limit;
* command timeout;
* network access;
* environment variables;
* secrets;
* shared package caches.

---

## Project detail page

Use tabs or internal navigation such as:

```text
Overview
Roles
Workspaces
Repository
Settings
```

### Roles

A project can have multiple roles, such as:

```text
Reviewer
Developer
Maintainer
Release
```

Each role defines:

* external integration tools;
* per-tool adapters;
* workspace tools;
* Git capabilities;
* sandbox policy;
* workspace creation permissions;
* maximum active workspaces.

A role may create multiple active workspaces.

### Workspaces

Show:

* workspace label;
* opaque workspace handle;
* assigned project role;
* branch;
* base branch;
* worktree state;
* sandbox state;
* creation time;
* last activity;
* Git status;
* resource usage where available.

Available actions may include:

* create workspace;
* stop or start sandbox;
* inspect status;
* view diff;
* release workspace;
* delete workspace;
* copy workspace handle.

Ordinary tool callers should not receive a workspace-listing capability unless their project role explicitly grants it. The admin UI may list all workspaces.

### Workspace creation

Administrators or authorized project callers create a workspace under a selected role.

Subpolar then creates:

```text
one Git worktree
one isolated sandbox
one opaque workspace handle
```

Each workspace-scoped tool requires the handle.

---

# User and authentication features

The web interface needs normal account-management features expected from an administrative application.

## Authentication

Include:

* sign in;
* sign out;
* secure session handling;
* password hashing;
* rate limiting;
* CSRF protection where applicable;
* session revocation;
* optional persistent sign-in;
* audit logging for security-sensitive actions.

## Password recovery

Include a standard forgot-password flow:

```text
Forgot password
→ enter email
→ receive time-limited reset link
→ set new password
→ revoke or optionally revoke existing sessions
```

Requirements:

* reset tokens must be single-use;
* tokens must expire;
* responses should not reveal whether an email exists;
* password reset attempts should be rate-limited;
* old reset tokens should become invalid after a successful reset.

## User profile

Users should be able to:

* change display name;
* change email;
* change password;
* view active sessions;
* revoke active sessions;
* sign out from all devices.

## Administrative user management

The **Users** sidebar section should allow administrators to:

* list users;
* create users;
* disable or re-enable users;
* reset a user’s access;
* assign platform roles;
* revoke sessions;
* review recent security events.

Initial platform roles can remain simple:

```text
Admin
User
```

An administrator can configure the platform.

A normal user may be granted access to selected agent profiles or projects without being able to edit global configuration.

## Email verification

Support:

* verification email after registration or email changes;
* resend verification message;
* expiring verification tokens.

Self-registration can be optional and disabled by default for self-hosted deployments.

---

# Authorization layers

Keep these distinct:

## Platform role

Controls access to the web interface and administrative features.

Examples:

```text
Admin
User
```

## Agent profile

Controls which stateless remote tools are exposed through a specific agent endpoint.

## Project role

Controls:

* project integration tools;
* workspace tools;
* Git capabilities;
* sandbox policy;
* workspace creation and cleanup.

## Workspace handle

Selects one concrete worktree and sandbox under an authorized project role.

---

# Web UI technical principles

The interface should consume the same backend API used by other clients.

Do not put configuration logic only in the frontend.

The UI should be:

* responsive;
* accessible;
* keyboard navigable;
* suitable for desktop administration;
* usable without exposing secret values;
* clear about degraded or unavailable tools;
* explicit when an action is destructive.

Important actions should use confirmation dialogs, especially:

* deleting providers;
* deleting agent profiles;
* deleting projects;
* deleting workspaces;
* revoking credentials;
* disabling users;
* rotating provider credentials.

---

# Updated implementation phases

## Phase 1 — Authentication and application foundation

Goal: establish the platform and administrative access.

Deliver:

* user storage;
* sign in and sign out;
* forgot-password flow;
* password reset;
* email verification;
* session management;
* admin and user platform roles;
* protected backend APIs;
* initial sidebar and application shell.

Success condition:

> An administrator can securely sign in, recover their password, manage sessions, and reach the protected administration interface.

---

## Phase 2 — Tool-provider management

Goal: configure all external tools from the web UI.

Deliver:

* Tools sidebar section;
* All Tools page;
* MCP provider creation;
* OpenAPI provider creation;
* centrally stored credentials;
* connection testing;
* MCP startup discovery;
* schema snapshot comparison;
* unavailable and changed-provider warnings;
* provider detail pages.

Success condition:

> An administrator can configure one MCP provider and one OpenAPI provider and inspect their available tools.

---

## Phase 3 — Agent profiles and adapters

Goal: create stateless model-facing tool profiles.

Deliver:

* Agents sidebar section;
* agent list;
* agent editor;
* per-agent tool selection;
* tool renaming;
* input and output adapters;
* fixed and hidden arguments;
* schema preview;
* adapter validation;
* testing;
* agent-profile access credentials.

Success condition:

> An administrator can expose `searxng.query` as `web.search` with a custom model-facing schema.

---

## Phase 4 — Project management and roles

Goal: configure repository-backed projects.

Deliver:

* Projects sidebar section;
* project creation;
* Git provider selection;
* repository configuration;
* project detail pages;
* multiple project roles;
* role-specific integration tools;
* role-specific workspace tools;
* sandbox policies;
* “Create default developer role” checkbox.

Success condition:

> An administrator can create a Gitea-backed project and receive a usable default developer role.

---

## Phase 5 — Worktrees and workspace handles

Goal: allow parallel isolated coding work.

Deliver:

* workspace creation from project roles;
* Subpolar-owned Git worktrees;
* high-entropy opaque workspace handles;
* multiple workspaces per project role;
* workspace status and lifecycle;
* admin workspace list;
* restrictions on workspace enumeration through agent tools.

Success condition:

> Two Codex threads can create separate workspaces under the same role and receive different opaque handles.

---

## Phase 6 — Workspace sandboxing

Goal: safely support general shell and filesystem access.

Deliver:

* one sandbox per workspace;
* exclusive worktree mounts;
* filesystem tools;
* shell execution;
* resource limits;
* network policy;
* isolated home and temporary directories;
* configurable shared caches;
* workspace inspection through the admin UI.

Success condition:

> A process running in one workspace cannot read or modify another workspace.

---

## Phase 7 — Built-in Git workflow

Goal: support a complete coding workflow.

Deliver:

* local Git tools;
* remote fetch, pull, and push;
* selected Git-provider integration;
* pull-request creation;
* role-controlled Git capabilities;
* project and workspace Git status in the UI.

Success condition:

> A coding agent can create a workspace, edit code, run tests, commit, push, and open a pull request.

---

# Updated first complete milestone

The first end-to-end release should allow an administrator to:

1. Sign in or recover a forgotten password.
2. Add an MCP provider in **Tools**.
3. Add an OpenAPI provider in **Tools**.
4. Create an agent profile in **Agents**.
5. Rename and adapt one provider tool.
6. Generate credentials for that agent profile.
7. Create a project in **Projects**.
8. Select Gitea as its Git provider.
9. Enable **Create default developer role**.
10. Create two workspaces under that role.
11. Receive two distinct opaque workspace handles.
12. Use them from separate coding-agent threads.
13. Keep each thread isolated in its own worktree and sandbox.
14. Commit, push, and create separate pull requests.
15. View provider, agent, project, role, and workspace status in the web UI.

---

# Non-goals for the current version

Do not include yet:

* an embedded model runtime;
* agent conversations;
* model selection;
* prompt assembly;
* an agent-session launcher;
* autonomous orchestration;
* multi-agent scheduling;
* a chat interface resembling Perplexity Computer;
* arbitrary executable plugins;
* automatic merging or deployment.

The web interface is for **configuration, administration, status, and workspace management**, not for running the reasoning loop.

---

# Definition of success

Subpolar Tools succeeds when an administrator can configure providers, tool profiles, projects, project roles, users, and isolated workspaces through a secure web UI, while external harnesses can consume those capabilities through stable MCP or OpenAPI interfaces.

```text
Admin web UI
├─ All Tools
├─ Agents
├─ Projects
├─ Users
└─ Settings

External harness
└─ MCP / OpenAPI
   ├─ stateless agent tools
   └─ project workspace tools
      └─ opaque handle → one worktree → one sandbox
```

The web UI manages the system.

The harness performs the reasoning.

Subpolar owns tool resolution, credentials, authorization, projects, worktrees, sandboxing, and Git execution.
