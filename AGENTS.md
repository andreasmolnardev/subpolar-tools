## Subpolar glossary

**Tool provider**
A configured external source of tools, usually an MCP server or OpenAPI service. Subpolar stores its connection details and credentials.

**Tool**
A callable capability exposed to a model, such as `web.search`, `filesystem.read`, or `git.commit`.

**Tool adapter**
A per-profile mapping that changes how a provider tool appears to the model. It can rename the tool and reshape its input and output schemas.

**Tool resolver**
The small, stateless core that receives a model-visible tool call, checks the active profile, applies its adapter, calls the backing provider, and returns the adapted result.

**Agent profile**
A stateless authorization and presentation profile. It defines an agent-specific prompt and which remote tools the model can see, including their names and schemas. It is not a running agent.

**Project**
A configured Git repository managed by Subpolar. It contains project roles and can create isolated workspaces.

**Project role**
A reusable permission profile inside a project, such as `reviewer`, `developer`, or `maintainer`. It defines available integration, filesystem, shell, Git, and sandbox capabilities.

**Workspace**
One active working environment created under a project role. Each workspace owns exactly one Git worktree and one sandbox.

**Workspace slug**
The human-readable workspace name used in commands and interfaces, such as:

```text
subpolar/tool-adapters
```

**Workspace handle**
A private, high-entropy identifier used internally to route tool calls to the correct workspace. Pi extensions should inject it automatically and keep it hidden from the model.

**Worktree**
A separate checked-out working copy of a Git repository. Multiple worktrees let several agent threads modify different branches concurrently without sharing files.

**Sandbox**
The isolated execution environment attached to a workspace, normally one container per workspace. Filesystem and shell tools execute inside it.

**Workspace tool**
A built-in Subpolar operation that acts on a workspace, such as filesystem access, shell execution, Git status, committing, or pushing.

**Integration tool**
A remote tool backed by an MCP or OpenAPI provider, such as web search, issue tracking, calendars, or Home Assistant.

**Active target**
The agent profile or project workspace currently loaded into a Pi session. It determines the active prompt and tool set.

**Project profile / project-role workspace**
A workspace operating under a particular project role. Multiple workspaces may use the same role while remaining isolated.

**System prompt layer**
The prompt supplied by the selected Subpolar agent or workspace and added to Pi’s existing system instructions.

**Tool manifest**
The structured list of tools available for an active target, including names, descriptions, schemas, and internal execution identifiers.

**Harness**
The application running the model loop, conversation, and tool-call cycle—for example Pi, Codex, Claude Code, or OpenCode.

**Harness agnostic**
Subpolar does not depend on one particular model runner. Its tools can be consumed through standard interfaces such as MCP or OpenAPI.

**Model agnostic**
Subpolar does not depend on a particular language model or provider.

**Subpolar Pi extension**
The Pi integration that logs into Subpolar, selects agents or workspaces, loads their prompts and tools, and privately attaches workspace context to tool calls.

**subpolar-pi-web**
A ChatGPT-style web frontend for Pi. It uses Pi’s extension system generally while providing richer UI for Subpolar agents, projects, workspaces, and threads.
