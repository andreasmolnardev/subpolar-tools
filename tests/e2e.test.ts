import { afterAll, expect, test } from "bun:test";

const baseUrl = process.env.SUBPOLAR_E2E_URL;
const email = process.env.SUBPOLAR_E2E_EMAIL;
const password = process.env.SUBPOLAR_E2E_PASSWORD;
const enabled = Boolean(baseUrl && email && password);
const state: { adminToken?: string; workspaceIds: string[] } = { workspaceIds: [] };

async function request(path: string, init: RequestInit = {}, token = state.adminToken) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  return response;
}
async function create(path: string, body: unknown, token?: string) {
  const response = await request(path, { method: "POST", body: JSON.stringify(body) }, token);
  expect(response.status).toBe(201);
  return response.json() as Promise<any>;
}

if (!enabled) {
  test.skip("Docker E2E requires SUBPOLAR_E2E_URL, SUBPOLAR_E2E_EMAIL, and SUBPOLAR_E2E_PASSWORD", () => {});
} else {
  test("OpenAPI, MCP HTTP, MCP stdio, and workspace contracts", async () => {
    const signIn = await request(
      "/api/auth/sign-in",
      { method: "POST", body: JSON.stringify({ email, password }) },
      undefined,
    );
    expect(signIn.status).toBe(200);
    state.adminToken = ((await signIn.json()) as { token: string }).token;

    const openApi = await create("/api/providers", {
      name: "OpenAPI fixture",
      kind: "OpenAPI",
      endpoint: "http://mock-provider:4010",
      configuration: {
        schema: {
          openapi: "3.1.0",
          paths: { "/weather/{city}": { get: { operationId: "weather", parameters: [{ name: "city", in: "path" }] } } },
        },
      },
    });
    expect((await request(`/api/providers/${openApi.id}/test`, { method: "POST" })).status).toBe(200);

    const mcpHttp = await create("/api/providers", {
      name: "MCP HTTP fixture",
      kind: "MCP",
      endpoint: "http://mock-provider:4010/mcp",
      configuration: { transport: "http" },
    });
    expect((await request(`/api/providers/${mcpHttp.id}/test`, { method: "POST" })).status).toBe(200);

    const mcpStdio = await create("/api/providers", {
      name: "MCP stdio fixture",
      kind: "MCP",
      endpoint: "",
      configuration: {
        transport: "command",
        command: ["bun", "/app/docker/mcp-fixture.ts"],
        environment: { FIXTURE: "1" },
      },
    });
    expect((await request(`/api/providers/${mcpStdio.id}/test`, { method: "POST" })).status).toBe(200);

    const agent = await create("/api/agents", { name: "Contract agent", description: "E2E contract fixture" });
    const tools = [
      [
        openApi,
        "weather",
        "weather.lookup",
        { city: "city" },
        { fixed: "hidden" },
        { temperature: "result.temperature" },
      ],
      [
        mcpHttp,
        "http.echo",
        "mcp.http",
        { query: "query" },
        { fixed: "hidden" },
        { result: "echo.query", transport: "transport" },
      ],
      [mcpStdio, "stdio.echo", "mcp.stdio", { query: "query" }, {}, { result: "echo.query", transport: "transport" }],
    ];
    for (const [provider, operation, exposedName, inputMap, fixedArgs, outputMap] of tools)
      await create(`/api/agents/${agent.id}/tools`, {
        providerId: provider.id,
        operation,
        exposedName,
        inputSchema: { type: "object", required: [Object.keys(inputMap)[0]] },
        inputMap,
        fixedArgs,
        outputMap,
      });
    const credential = await create(`/api/agents/${agent.id}/credentials`, { name: "E2E harness" });

    const call = async (name: string, body: object) => {
      const response = await request(
        `/api/v1/tools/${name}`,
        { method: "POST", body: JSON.stringify(body) },
        credential.secret,
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    expect((await call("weather.lookup", { city: "arctic" })).output).toEqual({ temperature: "weather:arctic" });
    expect((await call("mcp.http", { query: "ice" })).output).toEqual({ result: "ice", transport: "http" });
    expect((await call("mcp.stdio", { query: "snow" })).output).toEqual({ result: "snow", transport: "stdio" });

    const openApiContract = await request(`/api/v1/agents/${agent.id}/openapi.json`, {}, credential.secret);
    expect(openApiContract.status).toBe(200);
    expect((await openApiContract.json()).paths["/tools/weather.lookup"]).toBeDefined();
    const mcpList = await request(
      "/api/v1/mcp",
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      },
      credential.secret,
    );
    expect((await mcpList.json()).result.tools.map((tool: { name: string }) => tool.name)).toContain("mcp.stdio");

    const project = await create("/api/projects", {
      name: "Sandbox fixture",
      gitProvider: "Local",
      sandboxDefaults: { image: "alpine:3.21", network: false, timeout: 30 },
    });
    const roles = (await (await request(`/api/projects/${project.id}/roles`)).json()) as any[];
    const role = roles[0];
    const workspaceCredential = await create(`/api/roles/${role.id}/credentials`, { name: "E2E workspace" });
    const createWorkspace = async (label: string, branch: string) => {
      const response = await request(
        `/api/v1/projects/${project.id}/workspaces`,
        {
          method: "POST",
          body: JSON.stringify({ roleId: role.id, label, branch }),
        },
        workspaceCredential.secret,
      );
      expect(response.status).toBe(201);
      const workspace = (await response.json()) as any;
      state.workspaceIds.push(workspace.id);
      return workspace;
    };
    const first = await createWorkspace("first", "first");
    const second = await createWorkspace("second", "second");
    expect(first.sandboxState).toBe("Running");

    const write = await request(
      `/api/v1/workspaces/${first.handle}/files/write`,
      {
        method: "POST",
        body: JSON.stringify({ path: "visible.txt", content: "first workspace" }),
      },
      workspaceCredential.secret,
    );
    expect(write.status).toBe(200);
    const traversal = await request(
      `/api/v1/workspaces/${first.handle}/files/read`,
      {
        method: "POST",
        body: JSON.stringify({ path: `../${second.handle}/visible.txt` }),
      },
      workspaceCredential.secret,
    );
    expect(traversal.status).toBe(422);
    const shell = await request(
      `/api/v1/workspaces/${first.handle}/shell`,
      {
        method: "POST",
        body: JSON.stringify({ command: `test ! -e /workspace/../${second.handle} && test ! -e /var/run/docker.sock` }),
      },
      workspaceCredential.secret,
    );
    expect((await shell.json()).exitCode).toBe(0);

    const inspect = Bun.spawnSync([
      "docker",
      "inspect",
      "--format",
      "{{.HostConfig.NetworkMode}} {{range .Mounts}}{{.Source}} {{end}}",
      first.sandboxId,
    ]);
    expect(inspect.exitCode).toBe(0);
    const isolation = inspect.stdout.toString();
    expect(isolation).toStartWith("none ");
    expect(isolation).toContain(first.handle);
    expect(isolation).not.toContain(second.handle);
  }, 120_000);

  afterAll(async () => {
    for (const id of state.workspaceIds)
      await request(`/api/workspaces/${id}/release`, { method: "POST" }).catch(() => undefined);
  });
}
