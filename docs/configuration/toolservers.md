# Tool Server Configuration

This document describes the JSON payload accepted by **Add from JSON** in the
web console. The JSON is sent directly to `POST /api/providers`.

## Basic Shape

```json
{
  "name": "Weather tools",
  "kind": "OpenAPI",
  "endpoint": "https://api.example.com",
  "configuration": {
    "timeout": 10000,
    "schemaUrl": "https://api.example.com/openapi.json",
    "headers": {},
    "auth": {
      "type": "bearer"
    }
  },
  "schema": {},
  "credentialName": "Weather API",
  "credentialSecret": "replace-with-a-secret"
}
```

Required fields are `name` and `kind`. `kind` must be `OpenAPI` or `MCP`.
OpenAPI providers require `endpoint`; MCP command providers may omit it.

MCP providers use `configuration.transport` and `configuration.runtime` to
distinguish their execution mode:

- API: `transport: "http"`; provide `endpoint`.
- Local: `transport: "command"`, `runtime: "local"`; provide `command`.
- Docker: `transport: "command"`, `runtime: "docker"`; provide `image` and `command`.

`credentialSecret` is encrypted by the API before it is stored. Do not commit
provider JSON containing real secrets.

## OpenAPI

Use either `configuration.schemaUrl` or `configuration.schema` to describe the
service. If neither is supplied, the API attempts to discover the schema from
`endpoint`.

```json
{
  "name": "Internal API",
  "kind": "OpenAPI",
  "endpoint": "https://internal.example.com",
  "configuration": {
    "schemaUrl": "https://internal.example.com/openapi.json",
    "timeout": 15000,
    "headers": {
      "X-Client": "subpolar"
    },
    "auth": {
      "type": "header",
      "header": "X-API-Key",
      "prefix": ""
    }
  },
  "credentialName": "Internal API key",
  "credentialSecret": "replace-with-a-secret"
}
```

Supported authentication types are `bearer`, `header`, and `basic`.

## MCP HTTP

Set `kind` to `MCP`, `configuration.transport` to `http`, and provide an MCP
HTTP endpoint.

```json
{
  "name": "Remote MCP server",
  "kind": "MCP",
  "endpoint": "https://mcp.example.com/mcp",
  "configuration": {
    "transport": "http",
    "timeout": 10000,
    "headers": {},
    "auth": {
      "type": "bearer"
    }
  },
  "credentialName": "Remote MCP token",
  "credentialSecret": "replace-with-a-token"
}
```

## MCP Command / Stdio

Command providers use a non-empty string array in
`configuration.command`. `startup` may be `on-demand` or `eager`.

```json
{
  "name": "Filesystem MCP",
  "kind": "MCP",
  "configuration": {
    "transport": "command",
    "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    "startup": "on-demand",
    "environment": {
      "NODE_ENV": "production"
    },
    "timeout": 10000
  }
}
```

The command runs in the server environment. Only use commands and paths that
are trusted by the administrator.

## MCP Docker

Docker MCP servers run as disposable containers with stdin attached. The
configured command is appended after the image name, and environment values
are passed with Docker `-e` flags.

```json
{
  "name": "Docker MCP server",
  "kind": "MCP",
  "configuration": {
    "transport": "command",
    "runtime": "docker",
    "image": "ghcr.io/example/mcp-server:latest",
    "command": ["server", "--stdio"],
    "environment": {
      "NODE_ENV": "production"
    }
  }
}
```
