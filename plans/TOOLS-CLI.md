# Tools CLI Plan

## Goal

Provide a standalone Bun CLI for invoking tools exposed by an agent profile without requiring an MCP or OpenAPI client. The CLI is a development and harness client; it is not included in the production Docker image.

## Interface

The executable is named `subpolar-tools`.

```sh
SUBPOLAR_AGENT_TOKEN=spat_... subpolar-tools get
SUBPOLAR_AGENT_TOKEN=spat_... subpolar-tools weather.lookup '{"city":"arctic"}'
```

- Read the profile credential from `SUBPOLAR_AGENT_TOKEN`.
- Read the server origin from `SUBPOLAR_API_URL`, defaulting to `http://localhost:3000`.
- `get` lists the tools exposed by the credential's agent profile.
- Any other first positional argument is an exposed tool name, such as `weather.lookup`.
- The optional second positional argument is a JSON object supplied as the tool input. Omitted input is `{}`.
- Print successful values as JSON on stdout. Print diagnostics on stderr and return a non-zero exit code on failure.

The tool identifier is the profile's exposed name, not a provider ID or an underlying provider operation. This preserves the authorization and adapter boundaries enforced by the existing agent tool API.

## Implementation

1. Add a dedicated CLI workspace, for example `packages/cli`, with a `bin` entry that exposes `subpolar-tools`. Keep it independent of the web application and API service package.
2. Implement a small Bun TypeScript entrypoint that parses `process.argv` without adding a command-framework dependency.
3. Validate configuration before making requests:
   - reject a missing `SUBPOLAR_AGENT_TOKEN`;
   - reject an invalid `SUBPOLAR_API_URL`;
   - show usage for a missing command or too many positional arguments;
   - parse the properties argument as a JSON object, rejecting arrays, scalars, and malformed JSON.
4. Implement `get` using MCP JSON-RPC at `POST /api/v1/mcp` with `{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }`. Authenticate with `Authorization: Bearer <token>` and print the returned `result.tools`.
5. Implement invocation using `POST /api/v1/tools/:tool`, URL-encoding the exposed tool name, authenticating with the same bearer token, and printing the returned `output`.
6. Normalize non-success responses into concise stderr messages. Prefer the API's JSON `error` or JSON-RPC error message when present; include HTTP status for transport failures. Do not print credentials or request authorization headers.
7. Add package scripts for type checking and tests, then include the CLI workspace in the root build and test workflow.

## Verification

1. Add CLI-focused tests for argument parsing, default empty input, environment validation, JSON-object validation, request path construction, and stdout/stderr plus exit-code behavior.
2. Extend the existing Docker E2E contract setup to run the built CLI against the fixture agent credential. Verify `get` lists the expected exposed tools and calls succeed for OpenAPI, MCP HTTP, and MCP stdio tools.
3. Verify rejected credentials, unknown tools, malformed properties, and provider/API errors return non-zero without leaking tokens.
4. Run `bun run format:check`, `bun run build`, `bun test`, and `bun run test:e2e`.

## Packaging And Documentation

1. Do not copy the CLI workspace or executable into the production Docker image and do not add it to the container entrypoint.
2. Update the root README with installation/development invocation, `SUBPOLAR_AGENT_TOKEN`, `SUBPOLAR_API_URL`, command examples, JSON input requirements, and the distinction between exposed tool names and provider operations.
3. Document that the CLI is a direct client for agent-profile tools and uses the same authorization as the existing MCP and OpenAPI surfaces.
