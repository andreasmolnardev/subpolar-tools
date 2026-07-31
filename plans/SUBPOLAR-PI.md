# Subpolar Tools Pi Extension Plan

## Purpose

Build a Pi extension package named `subpolar-pi`. The extension connects Pi to a
Subpolar Tools instance and gives each Pi session exactly one active Subpolar
context:

- a stateless standalone agent profile; or
- an isolated project workspace with a project role, worktree, sandbox, and
  workspace-scoped tools.

Pi remains the model and reasoning harness. Subpolar supplies authorization,
prompts, tool manifests, project roles, workspaces, worktrees, sandboxes, and
tool execution. The extension must keep credentials, provider credentials,
opaque workspace handles, host paths, sandbox identifiers, and internal tool
names outside model-visible content.

## User workflows

The extension provides these commands:

```text
/subpolar
/subpolar login [url]
/subpolar switch
/subpolar status
/subpolar logout

/agent
/agent <agent-name>
/agent <project>/<workspace>
/agent status
/agent refresh
/agent clear

/workspace
/workspace create [project role workspace-slug]
/workspace list [project]
/workspace status
/workspace release
/workspace delete
```

`/subpolar` manages saved instances and authentication. `/agent` selects the
active agent profile or project workspace. `/workspace` manages workspace
lifecycle and activates newly created workspaces immediately.

## Data model

```ts
type SubpolarInstance = {
  id: string;
  name: string;
  baseUrl: string;
  authMethod: "token" | "session";
  credentialReference: string;
};

type ActiveTarget =
  | { kind: "agent"; instanceId: string; agentSlug: string }
  | {
      kind: "workspace";
      instanceId: string;
      projectSlug: string;
      workspaceSlug: string;
      workspaceHandle: string;
    };

type SubpolarSessionState = {
  instanceId: string | null;
  activeTarget:
    | { kind: "agent"; agentSlug: string }
    | {
        kind: "workspace";
        projectSlug: string;
        workspaceSlug: string;
        workspaceHandle: string;
      }
    | null;
  manifestVersion?: string;
  promptVersion?: string;
};
```

Instance credentials belong in the OS-native credential store, Pi secure secret
storage, or an encrypted local store. Environment variables are a development
fallback only. Session state is private extension state and must never be
inserted into conversation content.

## Activation behavior

Agent activation resolves the profile, loads its effective prompt and exposed
tool manifest, validates both, atomically replaces the prior Subpolar target,
persists the target, and reports a concise summary.

Workspace activation resolves project and workspace slugs, verifies access,
retrieves the opaque handle and role metadata privately, loads the effective
prompt and workspace tool manifest, and performs the same atomic replacement.
Only `project/workspace`, role, branch, and other safe human-readable metadata
may be shown to the model or user.

Switching must disable old Subpolar tools before installing the new prompt and
tools. Old wrappers must not execute against a newly selected target. Unrelated
Pi or extension tools must remain enabled.

## Prompt management

Install the effective Subpolar prompt as a dedicated layer bounded by:

```text
<subpolar-agent-context>
...
</subpolar-agent-context>
```

For workspaces, append a safe context summary containing project, workspace,
role, and branch, plus a statement that workspace tools are already scoped.
Never include credentials, handles, host paths, sandbox IDs, or private admin
metadata. Replace the layer on target switch, remove it on clear/logout, and
reload it on `/agent refresh` or session restoration.

## Tool management

Subpolar manifests contain exposed names, descriptions, input schemas, optional
output schemas, internal execution IDs, and workspace scope. Validate manifest
shape as untrusted remote data. Register one Pi wrapper per exposed tool.

Wrappers validate model arguments, bind the authenticated instance and current
target, inject the workspace handle privately for workspace-scoped calls, call
Subpolar, and normalize errors. The model-facing schema must never contain a
workspace handle and requests must reject model-supplied handles.

Tool names are sanitized deterministically when Pi disallows dots, for example
`filesystem.read` to `filesystem_read`. Detect collisions during activation
and reject ambiguous manifests rather than silently selecting a tool. Internal
execution IDs are never exposed.

Normalize failures to concise messages such as authentication expired,
workspace unavailable, tool unavailable, provider unavailable, permission
denied, sandbox stopped, timeout, or invalid arguments. Redact credentials,
secret headers, internal stack traces, and host paths.

## API client

Implement a typed authenticated client with request timeouts, cancellation,
API error normalization, token refresh and one retry after refresh. It needs
equivalents of these capabilities, adapting routes to the current Subpolar API
when necessary:

```text
POST /api/auth/sign-in             POST /api/auth/sign-out
GET  /api/me

GET  /api/agents                   GET  /api/agents/{id}/contract
POST /api/v1/tools/{tool}          POST /api/v1/mcp

GET  /api/projects                 GET  /api/projects/{id}/roles
GET  /api/projects/{id}/workspaces
POST /api/projects/{id}/workspaces
POST /api/workspaces/{id}/release
DELETE /api/workspaces/{id}

POST /api/v1/workspaces/{handle}/tools/{tool}
POST /api/v1/workspaces/{handle}/files/read
POST /api/v1/workspaces/{handle}/files/write
POST /api/v1/workspaces/{handle}/shell
POST /api/v1/workspaces/{handle}/git/{operation}
```

The client must support the existing session and bearer-token API while
allowing future Subpolar prompt and manifest endpoints.

## Persistence and restoration

Support multiple saved instances with independent credentials. Switching
instances clears the active target and resolves all target data again; handles
and slugs must never be reused across instances without validation.

On session load, restore the saved instance, validate authentication, resolve
the target, validate workspace access, and reload prompt and tools. If
restoration fails, keep Pi usable, disable Subpolar tools, retain no stale
active target, and suggest `/agent` or `/subpolar login`.

## Workspace lifecycle

`/workspace create` supports interactive project, role, name/slug, base branch,
and task context selection, plus a non-interactive
`/workspace create <project> <role> <workspace-slug>` form. It creates the
Subpolar-owned worktree and sandbox, privately stores the returned handle, and
activates the workspace.

Listing and status show only safe metadata: project/workspace reference, role,
branch, sandbox status, Git summary, creation time, and activity. Release
stops or releases the sandbox and clears the active target without deleting the
workspace. Delete requires confirmation, stops the sandbox, removes the
worktree according to Subpolar policy, revokes the handle, and disables tools.

## Suggested package layout

```text
packages/subpolar-pi/
├─ src/
│  ├─ index.ts
│  ├─ commands/{subpolar,agent,workspace}.ts
│  ├─ api/{client,auth,agents,projects,workspaces,tools}.ts
│  ├─ runtime/{target-manager,prompt-manager,tool-manager,tool-wrapper,lifecycle}.ts
│  ├─ state/{instance-store,credential-store,session-store}.ts
│  ├─ ui/{selectors,status,prompts,confirmations}.ts
│  ├─ schemas/{api-types,manifest,validation}.ts
│  └─ utils/{tool-names,errors,logging}.ts
├─ tests/{commands,runtime,state,integration}/
├─ package.json
├─ tsconfig.json
└─ README.md
```

`TargetManager` coordinates atomic activation, refresh, clear, and restore.
`PromptManager` owns the bounded prompt layer. `ToolManager` owns only the
currently active Subpolar wrappers. `SessionStore` persists per-session state
and keeps handles private. `SubpolarClient` owns authenticated HTTP behavior.

## Security and failure handling

- Never put tokens or workspace handles in prompts, messages, ordinary logs, or
  visible command output.
- Bind every workspace wrapper to the current private workspace binding.
- Never accept a model-provided workspace handle.
- Validate target ownership and access before activation and execution.
- Disable tools immediately after logout, invalidation, release, or deletion.
- Reject absolute paths where a relative workspace path is required.
- Do not expose workspace enumeration through model-visible tools.
- Confirm logout when it invalidates active access and confirm destructive delete.
- Treat remote prompts and manifests as untrusted input.
- Keep Pi usable when Subpolar is unavailable or authentication expires.
- Detect manifest version changes and require `/agent refresh` initially.

## Delivery phases

1. Connection and authentication: saved instances, secure credentials, login,
   status, logout, authenticated client, and restoration.
2. Standalone agents: listing, selection, prompt loading, dynamic tools,
   execution, clear, and per-session persistence.
3. Project workspaces: project/workspace selection, hidden handle binding,
   workspace prompts, and workspace manifests.
4. Workspace lifecycle: create, list, status, release, and confirmed delete.
5. Robustness: atomic switching, restoration, refresh, token refresh, stale
   targets, manifest versions, and a concise persistent status indicator.

## First end-to-end milestone

The first complete version must support login, standalone `research` activation
and remote tool execution, creation and activation of
`subpolar/tool-adapters`, prompt and tool replacement, filesystem/shell/Git
execution with the handle hidden, independent targets in two Pi sessions, and
independent restoration after restart.

Do not include model execution through Subpolar, model selection, conversation
synchronization, orchestration, multiple active targets, delegation, a
Subpolar chat UI, arbitrary prompt-merging configuration, direct provider
credentials, or model-entered workspace handles.
