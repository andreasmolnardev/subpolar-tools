import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import PocketBase from "pocketbase";
import { z } from "zod";
import {
  assertWorkspacePath as assertManagedWorkspacePath,
  decryptSecret as decryptStoredSecret,
  encryptSecret as encryptStoredSecret,
  isAdminOrGranted,
  mapAdapterInput,
  mappedOutput,
  safeWorkspacePath,
  schemaChanged,
  validateAdapter,
} from "./lib/runtime";

const pbUrl = process.env.PB_URL ?? "http://127.0.0.1:8090";
const pb = new PocketBase(pbUrl);
const app = new Hono();
const adminEmail = process.env.SUBPOLAR_ADMIN_EMAIL ?? "admin@example.com";
const adminPassword = process.env.SUBPOLAR_ADMIN_PASSWORD ?? "development-only-password";
const dockerCommand = process.env.DOCKER_BIN ?? "/usr/bin/docker";
const auditRetentionDays = Math.max(1, Number(process.env.SUBPOLAR_AUDIT_RETENTION_DAYS ?? 365));
const rateLimitRetentionMs = 15 * 60_000;
type McpSession = {
  process: ReturnType<typeof Bun.spawn>;
  pending: Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void; timeout: Timer }>;
  nextId: number;
  buffer: string;
  stderr: string;
  initialized?: any;
};
const mcpSessions = new Map<string, McpSession>();

type RecordData = Record<string, unknown> & { id: string; created: string; updated: string };
const json = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
const sha256 = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const token = () => crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
async function encryptSecret(value: string) {
  // The deployment secret is kept outside PocketBase so a database backup alone cannot reveal provider credentials.
  return encryptStoredSecret(value, process.env.SUBPOLAR_SECRET_KEY ?? adminPassword);
}
async function decryptSecret(value: string) {
  return decryptStoredSecret(value, process.env.SUBPOLAR_SECRET_KEY ?? adminPassword);
}

async function ensureCollection(name: string, type: "base" | "auth", fields: object[]) {
  try {
    await pb.collections.getOne(name);
  } catch {
    await pb.collections.create({
      name,
      type,
      fields,
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: "",
      deleteRule: "",
    });
  }
}

async function setup() {
  await pb.collection("_superusers").authWithPassword(adminEmail, adminPassword);
  const text = (name: string, required = false) => ({ name, type: "text", required });
  const number = (name: string) => ({ name, type: "number" });
  const bool = (name: string) => ({ name, type: "bool" });
  const jsonField = (name: string) => ({ name, type: "json" });
  await ensureCollection("platform_users", "auth", [
    text("displayName"),
    text("platformRole"),
    bool("enabled"),
    bool("verified"),
  ]);
  await ensureCollection("providers", "base", [
    text("name", true),
    text("kind", true),
    text("endpoint"),
    jsonField("configuration"),
    jsonField("schema"),
    text("status"),
    text("lastConnected"),
    bool("disabled"),
    text("credentialId"),
  ]);
  await ensureCollection("credentials", "base", [
    text("name", true),
    text("kind"),
    text("ciphertext"),
    text("ownerType"),
    text("ownerId"),
  ]);
  await ensureCollection("agents", "base", [text("name", true), text("description"), bool("enabled"), text("ownerId")]);
  await ensureCollection("agent_tools", "base", [
    text("agentId", true),
    text("providerId", true),
    text("operation", true),
    text("exposedName", true),
    text("description"),
    jsonField("inputSchema"),
    jsonField("inputMap"),
    jsonField("fixedArgs"),
    jsonField("outputMap"),
  ]);
  await ensureCollection("agent_credentials", "base", [
    text("agentId", true),
    text("name"),
    text("tokenHash", true),
    bool("revoked"),
    text("lastUsed"),
  ]);
  await ensureCollection("workspace_credentials", "base", [
    text("roleId", true),
    text("name"),
    text("tokenHash", true),
    bool("revoked"),
    text("lastUsed"),
  ]);
  await ensureCollection("sessions", "base", [
    text("userId", true),
    text("tokenHash", true),
    text("label"),
    text("lastUsed"),
    text("expiresAt"),
    bool("revoked"),
  ]);
  await ensureCollection("projects", "base", [
    text("name", true),
    text("description"),
    text("gitProvider"),
    text("repository"),
    text("defaultBranch"),
    jsonField("sandboxDefaults"),
    text("ownerId"),
  ]);
  await ensureCollection("roles", "base", [
    text("projectId", true),
    text("name", true),
    jsonField("capabilities"),
    jsonField("toolIds"),
    jsonField("sandboxPolicy"),
    number("maxWorkspaces"),
  ]);
  await ensureCollection("role_tools", "base", [
    text("roleId", true),
    text("providerId", true),
    text("operation", true),
    text("exposedName", true),
    text("description"),
    jsonField("inputSchema"),
    jsonField("inputMap"),
    jsonField("fixedArgs"),
    jsonField("outputMap"),
  ]);
  await ensureCollection("sandbox_secrets", "base", [
    text("projectId", true),
    text("name", true),
    text("ciphertext", true),
  ]);
  await ensureCollection("workspaces", "base", [
    text("projectId", true),
    text("roleId", true),
    text("handle", true),
    text("label"),
    text("branch"),
    text("baseBranch"),
    text("worktreePath"),
    text("sandboxId"),
    text("sandboxState"),
    text("gitStatus"),
    text("lastActivity"),
  ]);
  await ensureCollection("audit_events", "base", [
    text("actorId"),
    text("action"),
    text("resource"),
    jsonField("details"),
  ]);
  await ensureCollection("rate_limit_events", "base", [text("bucket", true), text("key", true)]);
  await ensureCollection("user_agent_grants", "base", [text("userId", true), text("agentId", true)]);
  await ensureCollection("user_project_grants", "base", [text("userId", true), text("projectId", true)]);
  try {
    await pb.collection("platform_users").getFirstListItem(`email="${adminEmail}"`);
  } catch {
    await pb.collection("platform_users").create({
      email: adminEmail,
      password: adminPassword,
      passwordConfirm: adminPassword,
      displayName: "Administrator",
      platformRole: "Admin",
      enabled: true,
      verified: true,
    });
  }
}

async function audit(actorId: string, action: string, resource: string, details: object = {}) {
  await pruneAuditEvents();
  await pb.collection("audit_events").create({ actorId, action, resource, details: redactAuditDetails(details) });
}

function redactAuditDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /password|secret|token|authorization|credential|ciphertext|api.?key/i.test(key)
        ? "[redacted]"
        : redactAuditDetails(item),
    ]),
  );
}

async function pruneAuditEvents() {
  const cutoff = Date.now() - auditRetentionDays * 24 * 60 * 60 * 1000;
  const expired = (await list("audit_events")).filter((event) => Date.parse(String(event.created)) < cutoff);
  await Promise.all(expired.map((event) => pb.collection("audit_events").delete(event.id)));
}

function auditResourceType(action: string) {
  if (/user|password/.test(action)) return "user";
  if (/provider/.test(action)) return "provider";
  if (/agent/.test(action)) return "agent";
  if (/project|role|workspace|sandbox/.test(action)) return "project";
  if (/session|sign_/.test(action)) return "session";
  return "resource";
}

async function auditEventView(
  event: RecordData,
  users: RecordData[],
): Promise<RecordData & { actor: object; resourceDetails: { type: string; id: unknown; label?: string } }> {
  const actor = users.find((user) => user.id === event.actorId);
  const resourceType = auditResourceType(String(event.action));
  let resourceLabel: string | undefined;
  if (resourceType === "user") {
    const user = users.find((item) => item.id === event.resource);
    resourceLabel = user ? String(user.displayName || user.email) : undefined;
  }
  return {
    ...event,
    details: redactAuditDetails(event.details),
    actor: actor ? { id: actor.id, displayName: actor.displayName, email: actor.email } : { id: event.actorId },
    resourceDetails: { type: resourceType, id: event.resource, ...(resourceLabel ? { label: resourceLabel } : {}) },
  };
}

async function currentSession(header?: string) {
  const value = header?.replace(/^Bearer\s+/i, "");
  if (!value) return null;
  const session = (await list("sessions", `tokenHash="${await sha256(value)}"`))[0];
  if (!session || session.revoked || Date.parse(String(session.expiresAt)) < Date.now()) return null;
  return session;
}
async function currentUser(header?: string) {
  const session = await currentSession(header);
  if (!session) return null;
  const user = await one("platform_users", String(session.userId));
  if (!user.enabled) return null;
  await pb.collection("sessions").update(session.id, { lastUsed: new Date().toISOString() });
  return user;
}

const requireUser = async (c: Context, admin = false) => {
  const user = await currentUser(c.req.header("Authorization"));
  if (!user || user.enabled === false) return null;
  if (admin && user.platformRole !== "Admin") return null;
  return user;
};
async function hasGrant(
  user: RecordData,
  collection: "user_agent_grants" | "user_project_grants",
  field: "agentId" | "projectId",
  id: string,
) {
  return isAdminOrGranted(
    user.platformRole,
    Boolean((await list(collection, `userId="${user.id}" && ${field}="${id}"`))[0]),
  );
}
async function canAccessAgent(user: RecordData, agent: RecordData) {
  return (
    user.platformRole === "Admin" ||
    agent.ownerId === user.id ||
    hasGrant(user, "user_agent_grants", "agentId", agent.id)
  );
}
const list = async (collection: string, filter = "") =>
  json(
    await pb.collection(collection).getFullList({ filter: filter.replace(/([A-Za-z0-9_])=/g, "$1 = ") }),
  ) as RecordData[];
const one = async (collection: string, id: string) => json(await pb.collection(collection).getOne(id)) as RecordData;
async function rateLimited(c: Context, bucket: string, limit = 5, windowMs = 60_000) {
  // Only accept forwarded addresses when the deployment explicitly trusts its proxy.
  const address =
    process.env.SUBPOLAR_TRUST_PROXY === "true"
      ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown")
      : "unknown";
  const key = await sha256(`${bucket}:${address}`);
  const cutoff = Date.now() - windowMs;
  const retentionCutoff = Date.now() - Math.max(windowMs, rateLimitRetentionMs);
  try {
    const events = await list("rate_limit_events");
    const expired = events.filter((event) => Date.parse(String(event.created)) < retentionCutoff);
    await Promise.all(expired.map((event) => pb.collection("rate_limit_events").delete(event.id)));
    await pb.collection("rate_limit_events").create({ bucket, key });
    return (
      events.filter(
        (event) => event.bucket === bucket && event.key === key && Date.parse(String(event.created)) >= cutoff,
      ).length >= limit
    );
  } catch (error) {
    console.error("Rate-limit storage unavailable", error);
    return true;
  }
}
const configOf = (record: RecordData) => (record.configuration ?? {}) as Record<string, unknown>;

function validateProviderConfiguration(configuration: Record<string, unknown>) {
  const strings = (value: unknown, field: string) => {
    if (value === undefined) return;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`${field} must be an object`);
    for (const [key, item] of Object.entries(value)) {
      if (!key || /[\r\n]/.test(key) || typeof item !== "string" || /[\r\n]/.test(item))
        throw new Error(`${field} must contain string values without line breaks`);
    }
  };
  strings(configuration.headers, "Provider headers");
  strings(configuration.environment, "MCP command environment");
  if (
    configuration.command !== undefined &&
    (!Array.isArray(configuration.command) ||
      !configuration.command.length ||
      !configuration.command.every((part) => typeof part === "string" && part.length))
  )
    throw new Error("MCP command transport requires configuration.command as a non-empty command array");
  if (configuration.startup !== undefined && !["on-demand", "eager"].includes(String(configuration.startup)))
    throw new Error("MCP startup must be on-demand or eager");
  const auth = configuration.auth as Record<string, unknown> | undefined;
  if (auth && !["bearer", "header", "basic"].includes(String(auth.type ?? "bearer")))
    throw new Error("Provider authentication type is invalid");
  return configuration;
}

const gitProviders = ["Gitea", "GitHub", "GitLab"] as const;
type GitProvider = (typeof gitProviders)[number];
function validateSandboxPolicy(policy: Record<string, unknown>) {
  const environment = policy.environment ?? {};
  const caches = policy.caches ?? {};
  const secretMounts = policy.secretMounts ?? [];
  if (typeof environment !== "object" || environment === null || Array.isArray(environment))
    throw new Error("Sandbox environment must be an object");
  for (const [name, value] of Object.entries(environment))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || /[\r\n]/.test(value))
      throw new Error("Sandbox environment values must be single-line strings with valid variable names");
  if (typeof caches !== "object" || caches === null || Array.isArray(caches))
    throw new Error("Sandbox caches must be an object");
  for (const [name, path] of Object.entries(caches))
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(name) || typeof path !== "string" || !/^\/[\w./-]+$/.test(path))
      throw new Error("Sandbox caches need a safe name and absolute container path");
  if (!Array.isArray(secretMounts)) throw new Error("Sandbox secret mounts must be an array");
  for (const mount of secretMounts) {
    if (!mount || typeof mount !== "object") throw new Error("Sandbox secret mount is invalid");
    const { secretId, mountPath } = mount as Record<string, unknown>;
    if (typeof secretId !== "string" || typeof mountPath !== "string" || !/^\/run\/secrets\/[\w.-]+$/.test(mountPath))
      throw new Error("Sandbox secrets must mount under /run/secrets");
  }
  if (policy.homeSize !== undefined && !/^\d+(?:[kmg])?$/i.test(String(policy.homeSize)))
    throw new Error("Sandbox home size is invalid");
  return policy;
}
function validateGitIdentity(policy: Record<string, unknown>) {
  const identity = policy.gitIdentity;
  if (identity === undefined) return;
  if (!identity || typeof identity !== "object" || Array.isArray(identity))
    throw new Error("Git author identity is invalid");
  const { name, email } = identity as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    /[\r\n]/.test(name) ||
    typeof email !== "string" ||
    !z.string().email().safeParse(email).success
  )
    throw new Error("Git author identity needs a name and valid email address");
}
function gitHeaders(provider: GitProvider, accessToken: string): Record<string, string> {
  return provider === "GitLab" ? { "PRIVATE-TOKEN": accessToken } : { Authorization: `Bearer ${accessToken}` };
}
async function projectView(project: RecordData) {
  const defaults = (project.sandboxDefaults ?? {}) as Record<string, any>;
  const integration = defaults.gitIntegration as { baseUrl?: string; credentialId?: string } | undefined;
  const { credentialId: _credentialId, ...safeIntegration } = integration ?? {};
  return {
    ...project,
    sandboxDefaults: {
      ...defaults,
      gitIntegration: integration
        ? { ...safeIntegration, credential: integration.credentialId ? "Configured" : "Not configured" }
        : undefined,
    },
  };
}

async function providerView(provider: RecordData) {
  const configuration = configOf(provider);
  const { credentialId, ...view } = provider;
  const headers = Object.keys((configuration.headers ?? {}) as Record<string, string>);
  const environment = Object.keys((configuration.environment ?? {}) as Record<string, string>);
  const credential = credentialId ? await one("credentials", String(credentialId)) : null;
  return {
    ...view,
    configuration: { ...configuration, headers, environment },
    credential: credential ? { name: credential.name, masked: "Configured" } : null,
  };
}

async function providerHeaders(provider: RecordData) {
  const configuration = configOf(provider);
  const headers = new Headers((configuration.headers ?? {}) as Record<string, string>);
  if (!provider.credentialId) return headers;
  const credential = await one("credentials", String(provider.credentialId));
  const secret = await decryptSecret(String(credential.ciphertext));
  const auth = (configuration.auth ?? { type: "bearer" }) as { type?: string; header?: string; prefix?: string };
  if (auth.type === "header") headers.set(auth.header || "Authorization", `${auth.prefix ?? ""}${secret}`);
  else if (auth.type === "basic") headers.set("Authorization", `Basic ${Buffer.from(secret).toString("base64")}`);
  else headers.set("Authorization", `Bearer ${secret}`);
  return headers;
}
function stopMcpSession(providerId: string) {
  const session = mcpSessions.get(providerId);
  if (!session) return;
  mcpSessions.delete(providerId);
  session.process.kill();
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("MCP command restarted"));
  }
}
async function mcpSession(provider: RecordData) {
  const existing = mcpSessions.get(provider.id);
  if (existing && existing.process.exitCode === null) return existing;
  if (existing) mcpSessions.delete(provider.id);
  const configuration = configOf(provider);
  const command = configuration.command;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === "string"))
    throw new Error("MCP command transport requires configuration.command as a non-empty command array");
  const environment = configuration.environment;
  if (environment !== undefined && (typeof environment !== "object" || Array.isArray(environment)))
    throw new Error("MCP command environment must be an object");
  const process = Bun.spawn({
    cmd: command as string[],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...((environment ?? {}) as Record<string, string>) },
  });
  const session: McpSession = { process, pending: new Map(), nextId: 1, buffer: "", stderr: "" };
  mcpSessions.set(provider.id, session);
  void (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        session.buffer += decoder.decode(value, { stream: true });
        let newline = session.buffer.indexOf("\n");
        while (newline >= 0) {
          const line = session.buffer.slice(0, newline).trim();
          session.buffer = session.buffer.slice(newline + 1);
          if (line) {
            try {
              const response = JSON.parse(line) as { id?: number };
              if (typeof response.id === "number") {
                const pending = session.pending.get(response.id);
                if (pending) {
                  clearTimeout(pending.timeout);
                  session.pending.delete(response.id);
                  pending.resolve(response);
                }
              }
            } catch {
              // MCP servers may emit diagnostics; only JSON-RPC responses are actionable.
            }
          }
          newline = session.buffer.indexOf("\n");
        }
      }
    } finally {
      if (mcpSessions.get(provider.id) === session) mcpSessions.delete(provider.id);
    }
  })();
  void new Response(process.stderr).text().then((value) => (session.stderr = value));
  void process.exited.then((exitCode) => {
    if (mcpSessions.get(provider.id) === session) mcpSessions.delete(provider.id);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(session.stderr || `MCP command exited with ${exitCode}`));
    }
    session.pending.clear();
  });
  return session;
}
async function mcpStdio(provider: RecordData, requests: Array<{ method: string; params: object }>) {
  const session = await mcpSession(provider);
  const timeout = Number(configOf(provider).timeout ?? 10000);
  const request = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error("MCP command timed out"));
      }, timeout);
      session.pending.set(id, { resolve, reject, timeout: timer });
      const stdin = session.process.stdin;
      if (!stdin || typeof stdin === "number") {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(new Error("MCP command stdin is unavailable"));
        return;
      }
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const responses: any[] = [];
  for (const item of requests) {
    if (item.method === "initialize" && session.initialized) responses.push(session.initialized);
    else {
      const response = await request(item.method, item.params);
      if (item.method === "initialize" && !response.error) session.initialized = response;
      responses.push(response);
    }
  }
  return responses;
}
function openApiOperations(document: Record<string, any>) {
  const operations: Record<string, unknown>[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {}))
    for (const [method, definition] of Object.entries(item as Record<string, any>)) {
      if (!/^(get|post|put|patch|delete|head)$/i.test(method)) continue;
      const operation = definition as Record<string, any>;
      operations.push({
        operationId: operation.operationId ?? `${method}.${path}`,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.description ?? "",
        parameters: operation.parameters ?? [],
        requestBody: operation.requestBody?.content?.["application/json"]?.schema ?? null,
        responses: operation.responses ?? {},
      });
    }
  return operations;
}
async function discover(provider: RecordData) {
  const configuration = configOf(provider);
  const headers = await providerHeaders(provider);
  let current: Record<string, unknown>;
  if (provider.kind === "OpenAPI") {
    const inline = configuration.schema;
    const response = inline
      ? null
      : await fetch(String(configuration.schemaUrl ?? provider.endpoint), {
          headers,
          signal: AbortSignal.timeout(Number(configuration.timeout ?? 10000)),
        });
    if (response && !response.ok) throw new Error(`Schema request failed with ${response.status}`);
    const document = (inline ?? (await response!.json())) as Record<string, any>;
    current = { format: "openapi", document, operations: openApiOperations(document) };
  } else {
    if (configuration.transport === "command") {
      const [initialized, listed] = await mcpStdio(provider, [
        {
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "subpolar", version: "1" } },
        },
        { method: "tools/list", params: {} },
      ]);
      if (initialized.error) throw new Error(initialized.error.message);
      if (listed.error) throw new Error(listed.error.message);
      current = { format: "mcp", serverInfo: initialized.result?.serverInfo, operations: listed.result?.tools ?? [] };
    } else {
      const rpc = async (method: string, params: object) => {
        const response = await fetch(String(provider.endpoint), {
          method: "POST",
          headers: {
            ...Object.fromEntries(headers),
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
          signal: AbortSignal.timeout(Number(configuration.timeout ?? 10000)),
        });
        if (!response.ok) throw new Error(`MCP request failed with ${response.status}`);
        return (await response.json()) as { result?: any; error?: { message: string } };
      };
      const initialized = await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "subpolar", version: "1" },
      });
      if (initialized.error) throw new Error(initialized.error.message);
      const listed = await rpc("tools/list", {});
      if (listed.error) throw new Error(listed.error.message);
      current = { format: "mcp", serverInfo: initialized.result?.serverInfo, operations: listed.result?.tools ?? [] };
    }
  }
  const prior = provider.schema as Record<string, unknown>;
  const changed = schemaChanged(prior?.current, current);
  return await pb.collection("providers").update(provider.id, {
    schema: { current, previous: prior?.current ?? null, changed, discoveredAt: new Date().toISOString() },
    status: "Available",
    lastConnected: new Date().toISOString(),
  });
}
async function invokeProvider(provider: RecordData, operationName: string, input: Record<string, unknown>) {
  const configuration = configOf(provider);
  const headers = await providerHeaders(provider);
  const current = ((provider.schema as Record<string, any>)?.current ?? {}) as Record<string, any>;
  if (provider.kind === "MCP") {
    if (configuration.transport === "command") {
      const [initialized, invoked] = await mcpStdio(provider, [
        {
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "subpolar", version: "1" } },
        },
        { method: "tools/call", params: { name: operationName, arguments: input } },
      ]);
      if (initialized.error) throw new Error(initialized.error.message);
      if (invoked.error) throw new Error(invoked.error.message);
      return invoked.result;
    }
    const response = await fetch(String(provider.endpoint), {
      method: "POST",
      headers: { ...Object.fromEntries(headers), "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: operationName, arguments: input },
      }),
      signal: AbortSignal.timeout(Number(configuration.timeout ?? 10000)),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (!response.ok || body.error)
      throw new Error(body.error?.message ?? `MCP request failed with ${response.status}`);
    return body.result;
  }
  const operation = (current.operations ?? []).find((candidate: any) => candidate.operationId === operationName) as
    Record<string, any> | undefined;
  if (!operation) throw new Error(`OpenAPI operation not found: ${operationName}`);
  let path = String(operation.path).replace(/\{([^}]+)\}/g, (_: string, key: string) =>
    encodeURIComponent(String(input[key] ?? "")),
  );
  const query = new URLSearchParams();
  for (const parameter of operation.parameters ?? [])
    if (parameter.in === "query" && input[parameter.name] !== undefined)
      query.set(parameter.name, String(input[parameter.name]));
  if (query.size) path += `?${query}`;
  if (operation.requestBody) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(path, String(provider.endpoint)).toString(), {
    method: operation.method,
    headers,
    body: operation.requestBody ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(Number(configuration.timeout ?? 10000)),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok)
    throw new Error(
      `OpenAPI request failed with ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`,
    );
  return body;
}
function commandOutput(command: string[], timeout = 60000) {
  const process = Bun.spawnSync(command, { timeout });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString() || `Command failed with ${process.exitCode}`);
  return process.stdout.toString();
}
function workspaceRoot() {
  return process.env.WORKSPACE_ROOT ?? "/var/lib/subpolar/workspaces";
}
function assertWorkspacePath(path: string) {
  return assertManagedWorkspacePath(workspaceRoot(), path);
}
async function projectGitEnvironment(project: RecordData) {
  const integration = ((project.sandboxDefaults ?? {}) as Record<string, any>).gitIntegration as
    { credentialId?: string } | undefined;
  if (!integration?.credentialId) return {};
  let repository: URL;
  try {
    repository = new URL(String(project.repository));
  } catch {
    throw new Error("Git credentials require an HTTPS repository URL");
  }
  if (repository.protocol !== "https:") throw new Error("Git credentials require an HTTPS repository URL");
  const credential = await one("credentials", integration.credentialId);
  const accessToken = await decryptSecret(String(credential.ciphertext));
  const identity =
    project.gitProvider === "GitHub"
      ? `x-access-token:${accessToken}`
      : project.gitProvider === "GitLab"
        ? `oauth2:${accessToken}`
        : `${accessToken}:`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${repository.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(identity).toString("base64")}`,
  };
}
async function workspaceGit(
  workspace: RecordData,
  operation: "status" | "diff" | "log" | "branch" | "commit" | "fetch" | "pull" | "push",
  message?: string,
) {
  const project = await one("projects", String(workspace.projectId));
  const path = assertWorkspacePath(String(workspace.worktreePath));
  const args = ["git", "-C", path];
  if (operation === "commit") {
    const identity = ((project.sandboxDefaults ?? {}) as Record<string, any>).gitIdentity as
      { name?: string; email?: string } | undefined;
    if (!identity?.name || !identity.email)
      throw new Error("Configure the project Git author name and email before committing");
    args.push("-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-m", message!);
  } else {
    const operations = {
      status: ["status", "--short", "--branch"],
      diff: ["diff", "--stat"],
      log: ["log", "--oneline", "-20"],
      branch: ["branch", "--show-current"],
      fetch: ["fetch", "origin"],
      pull: ["pull", "--ff-only", "origin", String(project.defaultBranch)],
      push: ["push", "origin", "HEAD"],
    } as const;
    args.push(...operations[operation]);
  }
  const result = Bun.spawnSync(args, {
    timeout: 60_000,
    env: { ...process.env, ...(await projectGitEnvironment(project)) },
  });
  await pb.collection("workspaces").update(workspace.id, { lastActivity: new Date().toISOString() });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
async function sandboxArgs(worktreePath: string, handle: string, projectId: string, policy: Record<string, unknown>) {
  validateSandboxPolicy(policy);
  const environment = (policy.environment ?? {}) as Record<string, unknown>;
  const caches = (policy.caches ?? {}) as Record<string, unknown>;
  const secretMounts = (policy.secretMounts ?? []) as Array<{ secretId: string; mountPath: string }>;
  const args = [
    "run",
    "-d",
    "--rm",
    "--name",
    `subpolar-${handle}`,
    "--cpus",
    String(policy.cpu ?? "1"),
    "--memory",
    String(policy.memory ?? "1g"),
    "--pids-limit",
    String(policy.pids ?? 256),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    "-v",
    `${worktreePath}:/workspace`,
    "-w",
    "/workspace",
    "--network",
    policy.network ? "bridge" : "none",
  ];
  if (policy.isolatedHome !== false) {
    args.push(
      "--tmpfs",
      `/home/subpolar:rw,nosuid,nodev,size=${String(policy.homeSize ?? "64m")}`,
      "-e",
      "HOME=/home/subpolar",
    );
  }
  for (const [name, value] of Object.entries(environment)) args.push("-e", `${name}=${String(value)}`);
  for (const [name, path] of Object.entries(caches))
    args.push("-v", `subpolar-cache-${projectId}-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}:${String(path)}`);
  const root = process.env.WORKSPACE_ROOT ?? "/var/lib/subpolar/workspaces";
  for (const mount of secretMounts) {
    const secret = await one("sandbox_secrets", mount.secretId);
    if (secret.projectId !== projectId) throw new Error("Sandbox secret does not belong to this project");
    const path = `${root}/secrets/${projectId}/${secret.id}`;
    commandOutput(["mkdir", "-p", `${root}/secrets/${projectId}`]);
    await Bun.write(path, await decryptSecret(String(secret.ciphertext)));
    commandOutput(["chmod", "600", path]);
    args.push("-v", `${path}:${mount.mountPath}:ro`);
  }
  return args;
}
function workspaceTimeout(policy: Record<string, unknown>) {
  return Math.max(1, Math.min(Number(policy.timeout ?? 600), 3600)) * 1000;
}
async function workspaceForCredential(c: Context) {
  const raw = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const credential = (await list("workspace_credentials", `tokenHash="${await sha256(raw)}"`))[0];
  if (!credential || credential.revoked) return null;
  const workspace = (await list("workspaces", `handle="${c.req.param("handle")}"`))[0];
  if (!workspace || workspace.roleId !== credential.roleId) return null;
  return { credential, workspace };
}

app.use("/api/*", cors({ origin: process.env.SUBPOLAR_ORIGIN ?? "http://localhost:3000", credentials: false }));
app.onError((error, c) => {
  if (error instanceof z.ZodError)
    return c.json({ error: "Invalid request", details: error.issues.map((issue) => issue.message) }, 400);
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});
app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/sign-in", async (c) => {
  if (await rateLimited(c, "sign-in", 10)) return c.json({ error: "Too many attempts; try again shortly" }, 429);
  const input = z
    .object({ email: z.string().email(), password: z.string().min(1), persistent: z.boolean().default(false) })
    .parse(await c.req.json());
  try {
    const auth = await new PocketBase(pbUrl).collection("platform_users").authWithPassword(input.email, input.password);
    if (auth.record.enabled === false) return c.json({ error: "Invalid email or password" }, 401);
    const sessionToken = `sps_${token()}`;
    await pb.collection("sessions").create({
      userId: auth.record.id,
      tokenHash: await sha256(sessionToken),
      label: c.req.header("user-agent")?.slice(0, 120) ?? "Browser",
      lastUsed: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() +
          (input.persistent ? Number(process.env.SUBPOLAR_PERSISTENT_SESSION_DAYS ?? 30) : 1) * 24 * 60 * 60 * 1000,
      ).toISOString(),
      revoked: false,
    });
    await audit(auth.record.id, "sign_in", "session");
    return c.json({ token: sessionToken, user: json(auth.record) });
  } catch {
    return c.json({ error: "Invalid email or password" }, 401);
  }
});
app.post("/api/auth/forgot-password", async (c) => {
  if (await rateLimited(c, "password-reset", 5, 15 * 60_000)) return c.json({ ok: true });
  const input = z.object({ email: z.string().email() }).parse(await c.req.json());
  try {
    await pb.collection("platform_users").requestPasswordReset(input.email);
  } catch {
    /* Do not reveal account existence. */
  }
  return c.json({ ok: true });
});
app.post("/api/auth/reset-password", async (c) => {
  if (await rateLimited(c, "password-reset-confirm", 10, 15 * 60_000))
    return c.json({ error: "Too many attempts; try again shortly" }, 429);
  const input = z.object({ token: z.string().min(1), password: z.string().min(12) }).parse(await c.req.json());
  await pb.collection("platform_users").confirmPasswordReset(input.token, input.password, input.password);
  return c.json({ ok: true });
});
app.post("/api/auth/verify-email", async (c) => {
  const input = z.object({ token: z.string() }).parse(await c.req.json());
  await pb.collection("platform_users").confirmVerification(input.token);
  return c.json({ ok: true });
});
app.post("/api/auth/sign-out", async (c) => {
  const user = await requireUser(c);
  const session = await currentSession(c.req.header("Authorization"));
  if (session) await pb.collection("sessions").update(session.id, { revoked: true });
  if (user) await audit(user.id, "sign_out", "session");
  return c.json({ ok: true });
});
app.get("/api/me", async (c) => {
  const user = await requireUser(c);
  return user ? c.json(user) : c.json({ error: "Unauthorized" }, 401);
});
app.patch("/api/me", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const input = z
    .object({ displayName: z.string().min(1).optional(), email: z.string().email().optional() })
    .parse(await c.req.json());
  const updated = await pb.collection("platform_users").update(user.id, input);
  if (input.email) await pb.collection("platform_users").requestVerification(input.email);
  return c.json(json(updated));
});
app.post("/api/me/request-verification", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  await pb.collection("platform_users").requestVerification(String(user.email));
  await audit(user.id, "request_email_verification", "account");
  return c.json({ ok: true });
});
app.post("/api/me/change-password", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const input = z
    .object({ currentPassword: z.string().min(1), password: z.string().min(12) })
    .parse(await c.req.json());
  try {
    await new PocketBase(pbUrl)
      .collection("platform_users")
      .authWithPassword(String(user.email), input.currentPassword);
    await pb.collection("platform_users").update(user.id, {
      oldPassword: input.currentPassword,
      password: input.password,
      passwordConfirm: input.password,
    });
    const sessions = await list("sessions", `userId="${user.id}"`);
    await Promise.all(sessions.map((session) => pb.collection("sessions").update(session.id, { revoked: true })));
    await audit(user.id, "change_password", "account");
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "Current password is invalid" }, 422);
  }
});
app.get("/api/me/sessions", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const sessions = await list("sessions", `userId="${user.id}"`);
  return c.json(sessions.map(({ tokenHash, ...session }) => session));
});
app.post("/api/me/sessions/:id/revoke", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const session = await one("sessions", c.req.param("id"));
  if (session.userId !== user.id) return c.json({ error: "Forbidden" }, 403);
  await pb.collection("sessions").update(session.id, { revoked: true });
  await audit(user.id, "revoke_session", session.id);
  return c.json({ ok: true });
});
app.post("/api/me/sessions/revoke-all", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const sessions = await list("sessions", `userId="${user.id}"`);
  await Promise.all(sessions.map((session) => pb.collection("sessions").update(session.id, { revoked: true })));
  await audit(user.id, "revoke_all_sessions", "session");
  return c.json({ ok: true });
});

app.get("/api/users", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  return c.json(await list("platform_users"));
});
app.post("/api/users", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      email: z.string().email(),
      displayName: z.string().min(1),
      platformRole: z.enum(["Admin", "User"]),
      password: z.string().min(12),
    })
    .parse(await c.req.json());
  const user = await pb
    .collection("platform_users")
    .create({ ...input, passwordConfirm: input.password, enabled: true, verified: false });
  await audit(admin.id, "create_user", user.id);
  return c.json(json(user), 201);
});
app.patch("/api/users/:id", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ enabled: z.boolean().optional(), platformRole: z.enum(["Admin", "User"]).optional() })
    .parse(await c.req.json());
  const user = await pb.collection("platform_users").update(c.req.param("id"), input);
  await audit(admin.id, "update_user", user.id, input);
  return c.json(json(user));
});
app.post("/api/users/:id/reset-password", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const input = z.object({ password: z.string().min(12) }).parse(await c.req.json());
  await pb
    .collection("platform_users")
    .update(c.req.param("id"), { password: input.password, passwordConfirm: input.password });
  const sessions = await list("sessions", `userId="${c.req.param("id")}"`);
  await Promise.all(sessions.map((session) => pb.collection("sessions").update(session.id, { revoked: true })));
  await audit(admin.id, "admin_reset_password", c.req.param("id"));
  return c.json({ ok: true });
});
app.put("/api/users/:id/grants", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ agentIds: z.array(z.string()).default([]), projectIds: z.array(z.string()).default([]) })
    .parse(await c.req.json());
  const userId = c.req.param("id");
  const [agentGrants, projectGrants] = await Promise.all([
    list("user_agent_grants", `userId="${userId}"`),
    list("user_project_grants", `userId="${userId}"`),
  ]);
  await Promise.all([
    ...agentGrants.map((grant) => pb.collection("user_agent_grants").delete(grant.id)),
    ...projectGrants.map((grant) => pb.collection("user_project_grants").delete(grant.id)),
  ]);
  await Promise.all([
    ...input.agentIds.map((agentId) => pb.collection("user_agent_grants").create({ userId, agentId })),
    ...input.projectIds.map((projectId) => pb.collection("user_project_grants").create({ userId, projectId })),
  ]);
  await audit(admin.id, "update_user_grants", userId, {
    agents: input.agentIds.length,
    projects: input.projectIds.length,
  });
  return c.json(input);
});
app.get("/api/users/:id/grants", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const userId = c.req.param("id");
  const [agents, projects] = await Promise.all([
    list("user_agent_grants", `userId="${userId}"`),
    list("user_project_grants", `userId="${userId}"`),
  ]);
  return c.json({
    agentIds: agents.map((grant) => grant.agentId),
    projectIds: projects.map((grant) => grant.projectId),
  });
});
app.get("/api/users/:id/sessions", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const sessions = await list("sessions", `userId="${c.req.param("id")}"`);
  return c.json(sessions.map(({ tokenHash, ...session }) => session));
});
app.post("/api/users/:id/revoke-sessions", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const sessions = await list("sessions", `userId="${c.req.param("id")}"`);
  await Promise.all(sessions.map((session) => pb.collection("sessions").update(session.id, { revoked: true })));
  await audit(admin.id, "revoke_user_sessions", c.req.param("id"));
  return c.json({ ok: true });
});
app.post("/api/users/:id/sessions/:sessionId/revoke", async (c) => {
  const admin = await requireUser(c, true);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  const session = await one("sessions", c.req.param("sessionId"));
  if (session.userId !== c.req.param("id")) return c.json({ error: "Not found" }, 404);
  await pb.collection("sessions").update(session.id, { revoked: true });
  await audit(admin.id, "revoke_user_session", session.id, { userId: session.userId });
  return c.json({ ok: true });
});
app.get("/api/audit-events", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const query = z
    .object({
      action: z.string().max(120).optional(),
      actorId: z.string().max(64).optional(),
      resource: z.string().max(120).optional(),
      resourceType: z.string().max(40).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    })
    .parse(Object.fromEntries(new URL(c.req.url).searchParams));
  await pruneAuditEvents();
  const users = await list("platform_users");
  const events = await Promise.all((await list("audit_events")).map((event) => auditEventView(event, users)));
  return c.json({
    retentionDays: auditRetentionDays,
    events: events
      .filter(
        (event) =>
          (!query.action || event.action === query.action) &&
          (!query.actorId || event.actorId === query.actorId) &&
          (!query.resource || event.resource === query.resource) &&
          (!query.resourceType || event.resourceDetails.type === query.resourceType) &&
          (!query.from || String(event.created) >= query.from) &&
          (!query.to || String(event.created) <= query.to),
      )
      .sort((left, right) => String(right.created).localeCompare(String(left.created)))
      .slice(0, 100),
  });
});

app.get("/api/providers", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await Promise.all((await list("providers")).map(providerView)));
});
app.post("/api/providers", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1),
      kind: z.enum(["MCP", "OpenAPI"]),
      endpoint: z.string().default(""),
      configuration: z.record(z.unknown()).default({}),
      schema: z.record(z.unknown()).default({}),
      credentialName: z.string().optional(),
      credentialSecret: z.string().optional(),
    })
    .parse(await c.req.json());
  validateProviderConfiguration(input.configuration);
  if ((!input.endpoint && input.kind === "OpenAPI") || (!input.endpoint && input.configuration.transport !== "command"))
    return c.json({ error: "A provider endpoint is required unless MCP command transport is selected" }, 422);
  let credentialId = "";
  if (input.credentialSecret) {
    const credential = await pb.collection("credentials").create({
      name: input.credentialName ?? `${input.name} credential`,
      kind: input.kind,
      ciphertext: await encryptSecret(input.credentialSecret),
      ownerType: "provider",
      ownerId: "",
    });
    credentialId = credential.id;
  }
  let provider = await pb
    .collection("providers")
    .create({ ...input, credentialId, status: "Unknown", disabled: false, lastConnected: "" });
  if (input.kind === "MCP" && input.configuration.startup === "eager") {
    try {
      provider = await discover(json(provider) as unknown as RecordData);
    } catch {
      provider = await pb.collection("providers").update(provider.id, { status: "Unavailable" });
    }
  }
  await audit(user.id, "create_provider", provider.id);
  return c.json(await providerView(json(provider) as unknown as RecordData), 201);
});
app.post("/api/providers/:id/test", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const provider = await one("providers", c.req.param("id"));
  try {
    const updated = await discover(provider);
    await audit(user.id, "test_provider", provider.id, { status: "Available" });
    return c.json(await providerView(json(updated) as unknown as RecordData));
  } catch (error) {
    const updated = await pb.collection("providers").update(provider.id, { status: "Unavailable" });
    await audit(user.id, "test_provider", provider.id, { status: "Unavailable" });
    return c.json(
      {
        provider: await providerView(json(updated) as unknown as RecordData),
        error: error instanceof Error ? error.message : "Provider test failed",
      },
      422,
    );
  }
});
app.post("/api/providers/:id/refresh", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const updated = await discover(await one("providers", c.req.param("id")));
  await audit(user.id, "refresh_provider", updated.id);
  return c.json(await providerView(json(updated) as unknown as RecordData));
});
app.patch("/api/providers/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      disabled: z.boolean().optional(),
      name: z.string().min(1).optional(),
      schema: z.record(z.unknown()).optional(),
      endpoint: z.string().min(1).optional(),
      configuration: z.record(z.unknown()).optional(),
      credentialName: z.string().min(1).optional(),
      credentialSecret: z.string().min(1).optional(),
    })
    .parse(await c.req.json());
  const provider = await one("providers", c.req.param("id"));
  if (input.configuration) validateProviderConfiguration(input.configuration);
  let credentialId = String(provider.credentialId || "");
  if (input.credentialSecret) {
    const credential = await pb.collection("credentials").create({
      name: input.credentialName ?? `${provider.name} credential`,
      kind: provider.kind,
      ciphertext: await encryptSecret(input.credentialSecret),
      ownerType: "provider",
      ownerId: provider.id,
    });
    credentialId = credential.id;
  }
  const { credentialName, credentialSecret, ...changes } = input;
  const updated = await pb.collection("providers").update(c.req.param("id"), { ...changes, credentialId });
  if (input.configuration && provider.configuration && configOf(provider).transport === "command")
    stopMcpSession(provider.id);
  if (credentialSecret && provider.credentialId)
    await pb.collection("credentials").delete(String(provider.credentialId));
  if (input.configuration?.transport === "command" && input.configuration.startup === "eager") {
    try {
      await discover(json(updated) as unknown as RecordData);
    } catch {
      await pb.collection("providers").update(updated.id, { status: "Unavailable" });
    }
  }
  await audit(user.id, "update_provider", updated.id, { ...changes, credentialRotated: Boolean(credentialSecret) });
  return c.json(await providerView((await one("providers", updated.id)) as RecordData));
});
app.get("/api/providers/:id/usage", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  const providerId = c.req.param("id");
  const [tools, agents, roles] = await Promise.all([
    list("agent_tools", `providerId="${providerId}"`),
    list("agents"),
    list("roles"),
  ]);
  return c.json({
    agents: tools.map((tool) => ({
      tool: tool.exposedName,
      agent: agents.find((agent) => agent.id === tool.agentId)?.name ?? tool.agentId,
    })),
    roles: roles
      .filter((role) => (role.toolIds as string[]).includes(providerId))
      .map((role) => ({ id: role.id, name: role.name })),
  });
});
app.delete("/api/providers/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const provider = await one("providers", c.req.param("id"));
  const tools = await list("agent_tools", `providerId="${provider.id}"`);
  if (tools.length)
    return c.json({ error: "Provider is still used by agent tools; disable it or remove those tools first" }, 409);
  stopMcpSession(provider.id);
  if (provider.credentialId) await pb.collection("credentials").delete(String(provider.credentialId));
  await pb.collection("providers").delete(provider.id);
  await audit(user.id, "delete_provider", provider.id);
  return c.body(null, 204);
});

app.get("/api/agents", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const agents = (await list("agents")).filter(
    (agent) => user.platformRole === "Admin" || agent.ownerId === user.id || false,
  );
  if (user.platformRole !== "Admin") {
    const grants = await list("user_agent_grants", `userId="${user.id}"`);
    agents.push(
      ...(await list("agents")).filter(
        (agent) =>
          grants.some((grant) => grant.agentId === agent.id) && !agents.some((existing) => existing.id === agent.id),
      ),
    );
  }
  const tools = await list("agent_tools");
  return c.json(
    agents.map((agent) => ({ ...agent, toolCount: tools.filter((tool) => tool.agentId === agent.id).length })),
  );
});
app.post("/api/agents", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z.object({ name: z.string().min(1), description: z.string().default("") }).parse(await c.req.json());
  const agent = await pb.collection("agents").create({ ...input, enabled: true, ownerId: user.id });
  await audit(user.id, "create_agent", agent.id);
  return c.json(json(agent), 201);
});
app.patch("/api/agents/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ name: z.string().min(1).optional(), description: z.string().optional(), enabled: z.boolean().optional() })
    .parse(await c.req.json());
  const agent = await pb.collection("agents").update(c.req.param("id"), input);
  await audit(user.id, "update_agent", agent.id, input);
  return c.json(json(agent));
});
app.get("/api/agents/:id/tools", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await list("agent_tools", `agentId="${c.req.param("id")}"`));
});
app.post("/api/agents/:id/tools", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      providerId: z.string(),
      operation: z.string(),
      exposedName: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
      description: z.string().default(""),
      inputSchema: z.record(z.unknown()).default({}),
      inputMap: z.record(z.string()).default({}),
      fixedArgs: z.record(z.unknown()).default({}),
      outputMap: z.record(z.string()).default({}),
    })
    .parse(await c.req.json());
  const tool = await pb.collection("agent_tools").create({ ...input, agentId: c.req.param("id") });
  return c.json(json(tool), 201);
});
app.patch("/api/agents/:id/tools/:toolId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("agent_tools", c.req.param("toolId"));
  if (tool.agentId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this agent" }, 404);
  const input = z
    .object({
      providerId: z.string().optional(),
      operation: z.string().optional(),
      exposedName: z
        .string()
        .regex(/^[a-z][a-z0-9_.-]*$/)
        .optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional(),
      inputMap: z.record(z.string()).optional(),
      fixedArgs: z.record(z.unknown()).optional(),
      outputMap: z.record(z.string()).optional(),
    })
    .parse(await c.req.json());
  const updated = await pb.collection("agent_tools").update(tool.id, input);
  await audit(user.id, "update_agent_tool", tool.id, input);
  return c.json(json(updated));
});
app.delete("/api/agents/:id/tools/:toolId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("agent_tools", c.req.param("toolId"));
  if (tool.agentId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this agent" }, 404);
  await pb.collection("agent_tools").delete(tool.id);
  await audit(user.id, "delete_agent_tool", tool.id);
  return c.body(null, 204);
});
app.post("/api/agents/:id/tools/:toolId/test", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("agent_tools", c.req.param("toolId"));
  if (tool.agentId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this agent" }, 404);
  try {
    const input = await c.req.json();
    validateAdapter(input, tool.inputSchema as Record<string, any>);
    const mapped = mapAdapterInput(input, tool);
    const output = await invokeProvider(
      await one("providers", String(tool.providerId)),
      String(tool.operation),
      mapped,
    );
    return c.json({ output: mappedOutput(output, tool.outputMap as Record<string, string>) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Tool test failed" }, 422);
  }
});
app.get("/api/agents/:id/contract", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const agent = await one("agents", c.req.param("id"));
  if (!(await canAccessAgent(user, agent))) return c.json({ error: "Forbidden" }, 403);
  const tools = await list("agent_tools", `agentId="${agent.id}"`);
  return c.json({
    name: agent.name,
    description: agent.description,
    tools: tools.map((tool) => ({
      name: tool.exposedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputMap: tool.outputMap,
    })),
  });
});
app.get("/api/agents/:id/openapi.json", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const agent = await one("agents", c.req.param("id"));
  if (!(await canAccessAgent(user, agent))) return c.json({ error: "Forbidden" }, 403);
  return c.json(
    agentOpenApiContract(agent, await list("agent_tools", `agentId="${agent.id}"`), new URL(c.req.url).origin),
  );
});
app.post("/api/agents/:id/tools/:toolId/validate", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("agent_tools", c.req.param("toolId"));
  if (tool.agentId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this agent" }, 404);
  const provider = await one("providers", String(tool.providerId));
  const operations = ((provider.schema as Record<string, any>)?.current?.operations ?? []) as Record<string, any>[];
  const operation = operations.find((item) => item.operationId === tool.operation || item.name === tool.operation);
  if (!operation)
    return c.json({ valid: false, errors: ["Underlying operation is absent from the current provider schema"] });
  const exposed = Object.keys(tool.inputMap as object);
  const missing = Object.values(tool.inputMap as Record<string, string>).filter(
    (field) => !JSON.stringify(operation).includes(`\"${field}\"`),
  );
  return c.json({
    valid: !missing.length,
    errors: missing.length ? [`Mapped provider fields are not present: ${missing.join(", ")}`] : [],
    exposedFields: exposed,
  });
});
app.post("/api/agents/:id/credentials", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  const secret = `spat_${token()}`;
  const credential = await pb.collection("agent_credentials").create({
    agentId: c.req.param("id"),
    name: input.name,
    tokenHash: await sha256(secret),
    revoked: false,
    lastUsed: "",
  });
  await audit(user.id, "create_agent_credential", credential.id);
  return c.json({ credential: json(credential), secret }, 201);
});
app.get("/api/agents/:id/credentials", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const credentials = await list("agent_credentials", `agentId="${c.req.param("id")}"`);
  return c.json(credentials.map(({ tokenHash, ...credential }) => credential));
});
app.post("/api/agent-credentials/:id/revoke", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const credential = await pb.collection("agent_credentials").update(c.req.param("id"), { revoked: true });
  await audit(user.id, "revoke_agent_credential", credential.id);
  return c.json(json(credential));
});
app.delete("/api/agents/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const agent = await one("agents", c.req.param("id"));
  const [tools, credentials] = await Promise.all([
    list("agent_tools", `agentId="${agent.id}"`),
    list("agent_credentials", `agentId="${agent.id}"`),
  ]);
  await Promise.all([
    ...tools.map((tool) => pb.collection("agent_tools").delete(tool.id)),
    ...credentials.map((credential) => pb.collection("agent_credentials").delete(credential.id)),
  ]);
  await pb.collection("agents").delete(agent.id);
  await audit(user.id, "delete_agent", agent.id);
  return c.body(null, 204);
});

app.get("/api/projects", async (c) => {
  const user = await requireUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  let [projects, roles, workspaces] = await Promise.all([list("projects"), list("roles"), list("workspaces")]);
  if (user.platformRole !== "Admin") {
    const grants = await list("user_project_grants", `userId="${user.id}"`);
    projects = projects.filter(
      (project) => project.ownerId === user.id || grants.some((grant) => grant.projectId === project.id),
    );
    roles = roles.filter((role) => projects.some((project) => project.id === role.projectId));
    workspaces = workspaces.filter((workspace) => projects.some((project) => project.id === workspace.projectId));
  }
  return c.json(
    await Promise.all(
      projects.map(async (project) => ({
        ...(await projectView(project)),
        roleCount: roles.filter((role) => role.projectId === project.id).length,
        workspaceCount: workspaces.filter((workspace) => workspace.projectId === project.id).length,
      })),
    ),
  );
});
app.post("/api/projects", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1),
      description: z.string().default(""),
      gitProvider: z.enum(["Gitea", "GitHub", "GitLab", "Generic", "Local"]),
      repository: z.string().default(""),
      defaultBranch: z.string().default("main"),
      sandboxDefaults: z
        .record(z.unknown())
        .default({ image: "alpine:3.21", cpu: "1", memory: "1g", timeout: 600, network: false }),
      createDefaultDeveloperRole: z.boolean().default(true),
    })
    .parse(await c.req.json());
  validateSandboxPolicy(input.sandboxDefaults);
  validateGitIdentity(input.sandboxDefaults);
  const project = await pb.collection("projects").create({ ...input, ownerId: user.id });
  if (input.createDefaultDeveloperRole)
    await pb.collection("roles").create({
      projectId: project.id,
      name: "Developer",
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "filesystem.search",
        "shell.execute",
        "git.status",
        "git.diff",
        "git.log",
        "git.branch",
        "git.commit",
        "git.fetch",
        "git.pull",
        "git.push",
        "pull_request.create",
        "workspace.create",
        "workspace.cleanup",
      ],
      toolIds: [],
      sandboxPolicy: input.sandboxDefaults,
      maxWorkspaces: 5,
    });
  await audit(user.id, "create_project", project.id);
  return c.json(await projectView(json(project) as unknown as RecordData), 201);
});
app.get("/api/projects/:id/roles", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await list("roles", `projectId="${c.req.param("id")}"`));
});
app.get("/api/roles/:id/tools", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await list("role_tools", `roleId="${c.req.param("id")}"`));
});
app.post("/api/roles/:id/tools", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const role = await one("roles", c.req.param("id"));
  const input = z
    .object({
      providerId: z.string(),
      operation: z.string(),
      exposedName: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
      description: z.string().default(""),
      inputSchema: z.record(z.unknown()).default({}),
      inputMap: z.record(z.string()).default({}),
      fixedArgs: z.record(z.unknown()).default({}),
      outputMap: z.record(z.string()).default({}),
    })
    .parse(await c.req.json());
  if (!(role.toolIds as string[]).includes(input.providerId))
    return c.json({ error: "Select this provider for the role first" }, 422);
  const tool = await pb.collection("role_tools").create({ ...input, roleId: role.id });
  await audit(user.id, "create_role_tool", tool.id);
  return c.json(json(tool), 201);
});
app.patch("/api/roles/:id/tools/:toolId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("role_tools", c.req.param("toolId"));
  if (tool.roleId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this role" }, 404);
  const input = z
    .object({
      providerId: z.string().optional(),
      operation: z.string().optional(),
      exposedName: z
        .string()
        .regex(/^[a-z][a-z0-9_.-]*$/)
        .optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional(),
      inputMap: z.record(z.string()).optional(),
      fixedArgs: z.record(z.unknown()).optional(),
      outputMap: z.record(z.string()).optional(),
    })
    .parse(await c.req.json());
  const updated = await pb.collection("role_tools").update(tool.id, input);
  await audit(user.id, "update_role_tool", tool.id);
  return c.json(json(updated));
});
app.delete("/api/roles/:id/tools/:toolId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const tool = await one("role_tools", c.req.param("toolId"));
  if (tool.roleId !== c.req.param("id")) return c.json({ error: "Tool does not belong to this role" }, 404);
  await pb.collection("role_tools").delete(tool.id);
  await audit(user.id, "delete_role_tool", tool.id);
  return c.body(null, 204);
});
app.post("/api/projects/:id/roles", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1),
      capabilities: z.array(z.string()).default([]),
      maxWorkspaces: z.number().int().min(1).default(1),
      sandboxPolicy: z.record(z.unknown()).default({}),
      toolIds: z.array(z.string()).default([]),
    })
    .parse(await c.req.json());
  validateSandboxPolicy(input.sandboxPolicy);
  const role = await pb.collection("roles").create({ ...input, projectId: c.req.param("id") });
  return c.json(json(role), 201);
});
app.patch("/api/projects/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      repository: z.string().optional(),
      defaultBranch: z.string().min(1).optional(),
      gitProvider: z.enum(["Gitea", "GitHub", "GitLab", "Generic", "Local"]).optional(),
      sandboxDefaults: z.record(z.unknown()).optional(),
    })
    .parse(await c.req.json());
  if (input.sandboxDefaults) {
    validateSandboxPolicy(input.sandboxDefaults);
    validateGitIdentity(input.sandboxDefaults);
  }
  const project = await pb.collection("projects").update(c.req.param("id"), input);
  await audit(user.id, "update_project", project.id, input);
  return c.json(await projectView(json(project) as unknown as RecordData));
});
app.patch("/api/roles/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1).optional(),
      capabilities: z.array(z.string()).optional(),
      toolIds: z.array(z.string()).optional(),
      maxWorkspaces: z.number().int().min(1).optional(),
      sandboxPolicy: z.record(z.unknown()).optional(),
    })
    .parse(await c.req.json());
  if (input.sandboxPolicy) validateSandboxPolicy(input.sandboxPolicy);
  const role = await pb.collection("roles").update(c.req.param("id"), input);
  await audit(user.id, "update_role", role.id, input);
  return c.json(json(role));
});
app.delete("/api/roles/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const role = await one("roles", c.req.param("id"));
  if ((await list("workspaces", `roleId="${role.id}"`)).length)
    return c.json({ error: "Release this role's workspaces first" }, 409);
  await Promise.all(
    (await list("role_tools", `roleId="${role.id}"`)).map((tool) => pb.collection("role_tools").delete(tool.id)),
  );
  await pb.collection("roles").delete(role.id);
  await audit(user.id, "delete_role", role.id);
  return c.body(null, 204);
});
app.post("/api/projects/:id/git-credential", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const project = await one("projects", c.req.param("id")!);
  const input = z
    .object({ name: z.string().min(1), baseUrl: z.string().url(), token: z.string().min(1) })
    .parse(await c.req.json());
  const credential = await pb.collection("credentials").create({
    name: input.name,
    kind: "Git",
    ciphertext: await encryptSecret(input.token),
    ownerType: "project",
    ownerId: project.id,
  });
  const defaults = (project.sandboxDefaults ?? {}) as Record<string, unknown>;
  const updated = await pb.collection("projects").update(project.id, {
    sandboxDefaults: {
      ...defaults,
      gitIntegration: { baseUrl: input.baseUrl.replace(/\/$/, ""), credentialId: credential.id },
    },
  });
  const prior = ((project.sandboxDefaults ?? {}) as Record<string, any>).gitIntegration?.credentialId;
  if (prior) await pb.collection("credentials").delete(String(prior));
  await audit(user.id, "rotate_git_credential", project.id);
  return c.json({
    project: await projectView(json(updated) as unknown as RecordData),
    credential: { name: credential.name, masked: "Configured" },
  });
});
app.get("/api/projects/:id/sandbox-secrets", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const secrets = await list("sandbox_secrets", `projectId="${c.req.param("id")}"`);
  return c.json(secrets.map(({ ciphertext, ...secret }) => secret));
});
app.post("/api/projects/:id/sandbox-secrets", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/), value: z.string().min(1) })
    .parse(await c.req.json());
  const secret = await pb
    .collection("sandbox_secrets")
    .create({ projectId: c.req.param("id"), name: input.name, ciphertext: await encryptSecret(input.value) });
  await audit(user.id, "create_sandbox_secret", secret.id);
  const { ciphertext, ...view } = json(secret);
  return c.json(view, 201);
});
app.patch("/api/projects/:id/sandbox-secrets/:secretId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const secret = await one("sandbox_secrets", c.req.param("secretId"));
  if (secret.projectId !== c.req.param("id")) return c.json({ error: "Secret does not belong to this project" }, 404);
  const input = z.object({ value: z.string().min(1) }).parse(await c.req.json());
  await pb.collection("sandbox_secrets").update(secret.id, { ciphertext: await encryptSecret(input.value) });
  await audit(user.id, "rotate_sandbox_secret", secret.id);
  return c.json({ id: secret.id, name: secret.name, masked: "Configured" });
});
app.delete("/api/projects/:id/sandbox-secrets/:secretId", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const secret = await one("sandbox_secrets", c.req.param("secretId"));
  if (secret.projectId !== c.req.param("id")) return c.json({ error: "Secret does not belong to this project" }, 404);
  await pb.collection("sandbox_secrets").delete(secret.id);
  await audit(user.id, "delete_sandbox_secret", secret.id);
  return c.body(null, 204);
});
app.post("/api/git/repositories", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ provider: z.enum(gitProviders), baseUrl: z.string().url(), token: z.string().min(1) })
    .parse(await c.req.json());
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const endpoint =
    input.provider === "GitHub"
      ? `${baseUrl}/user/repos?per_page=100&sort=updated`
      : input.provider === "GitLab"
        ? `${baseUrl}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at`
        : `${baseUrl}/api/v1/user/repos?limit=100`;
  const response = await fetch(endpoint, {
    headers: { ...gitHeaders(input.provider, input.token), Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) return c.json({ error: `Repository lookup failed with ${response.status}` }, 422);
  const repositories = ((await response.json()) as any[]).map((repository) => ({
    name: repository.full_name ?? repository.path_with_namespace ?? repository.name,
    url: repository.clone_url ?? repository.http_url_to_repo ?? repository.ssh_url_to_repo,
    defaultBranch: repository.default_branch ?? "main",
  }));
  return c.json(repositories.filter((repository) => repository.url));
});
app.get("/api/projects/:id/workspaces", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  return c.json(await list("workspaces", `projectId="${c.req.param("id")}"`));
});
app.get("/api/workspaces/:id/inspect", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  let gitStatus = "";
  let diff = "";
  if (workspace.worktreePath) {
    const status = Bun.spawnSync(["git", "-C", String(workspace.worktreePath), "status", "--short"]);
    const changes = Bun.spawnSync(["git", "-C", String(workspace.worktreePath), "diff", "--stat"]);
    gitStatus = status.stdout.toString();
    diff = changes.stdout.toString();
  }
  const docker = workspace.sandboxId
    ? Bun.spawnSync([dockerCommand, "inspect", "--format", "{{.State.Status}}", String(workspace.sandboxId)])
    : null;
  const stats = workspace.sandboxId
    ? Bun.spawnSync([
        dockerCommand,
        "stats",
        "--no-stream",
        "--format",
        "{{.CPUPerc}} {{.MemUsage}}",
        String(workspace.sandboxId),
      ])
    : null;
  return c.json({
    ...workspace,
    gitStatus,
    diff,
    sandboxState: docker?.exitCode === 0 ? docker.stdout.toString().trim() : workspace.sandboxState,
    resourceUsage: stats?.exitCode === 0 ? stats.stdout.toString().trim() : "Unavailable",
  });
});
app.get("/api/workspaces/:id/diff", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  return c.json({ diff: commandOutput(["git", "-C", String(workspace.worktreePath), "diff"], 60_000) });
});
app.get("/api/workspaces/:id/logs", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  if (!workspace.sandboxId) return c.json({ logs: "Sandbox is stopped" });
  const result = Bun.spawnSync([dockerCommand, "logs", "--tail", "500", String(workspace.sandboxId)], {
    timeout: 60_000,
  });
  return c.json({ logs: result.stdout.toString() + result.stderr.toString() });
});
app.post("/api/workspaces/:id/git/:operation", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const operation = c.req.param("operation");
  if (!(["status", "diff", "log", "branch", "commit", "fetch", "pull", "push"] as string[]).includes(operation))
    return c.json({ error: "Unsupported Git operation" }, 404);
  const input =
    operation === "commit" ? z.object({ message: z.string().min(1).max(500) }).parse(await c.req.json()) : {};
  try {
    const workspace = await one("workspaces", c.req.param("id"));
    const result = await workspaceGit(
      workspace,
      operation as Parameters<typeof workspaceGit>[1],
      "message" in input && typeof input.message === "string" ? input.message : undefined,
    );
    await audit(user.id, `git_${operation}`, workspace.id);
    return c.json(result, result.exitCode === 0 ? 200 : 422);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Git operation failed" }, 422);
  }
});
const createWorkspace = async (c: Context) => {
  const user = await requireUser(c, true);
  const input = z
    .object({ roleId: z.string(), label: z.string().min(1), branch: z.string().min(1) })
    .parse(await c.req.json());
  const raw = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const roleCredential = (await list("workspace_credentials", `tokenHash="${await sha256(raw)}"`))[0];
  const agentCreated = !user && Boolean(roleCredential && !roleCredential.revoked);
  if (!user && !agentCreated) return c.json({ error: "Forbidden" }, 403);
  const role = await one("roles", input.roleId);
  if (agentCreated && roleCredential!.roleId !== role.id) return c.json({ error: "Forbidden" }, 403);
  if (agentCreated && !(role.capabilities as string[]).includes("workspace.create"))
    return c.json({ error: "Role cannot create workspaces" }, 403);
  const active = await list("workspaces", `roleId="${role.id}"`);
  if (active.length >= Number(role.maxWorkspaces)) return c.json({ error: "Role workspace limit reached" }, 409);
  const project = await one("projects", c.req.param("id")!);
  if (role.projectId !== project.id) return c.json({ error: "Role does not belong to this project" }, 422);
  const handle = `ws_${token()}`;
  const root = process.env.WORKSPACE_ROOT ?? "/var/lib/subpolar/workspaces";
  const worktreePath = `${root}/${handle}`;
  const repositoryPath = `${root}/repositories/${project.id}.git`;
  let sandboxId = "";
  let sandboxState = "Stopped";
  try {
    commandOutput(["mkdir", "-p", `${root}/repositories`]);
    if (project.repository) {
      const exists = Bun.file(repositoryPath).size > 0;
      if (!exists) commandOutput(["git", "clone", "--bare", String(project.repository), repositoryPath]);
      else commandOutput(["git", "--git-dir", repositoryPath, "fetch", "origin", String(project.defaultBranch)]);
      commandOutput([
        "git",
        "--git-dir",
        repositoryPath,
        "worktree",
        "add",
        "-b",
        input.branch,
        worktreePath,
        `origin/${project.defaultBranch}`,
      ]);
    } else commandOutput(["mkdir", "-p", worktreePath]);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? `Workspace setup failed: ${error.message}` : "Workspace setup failed" },
      422,
    );
  }
  if (agentCreated) {
    const policy = (role.sandboxPolicy ?? project.sandboxDefaults ?? {}) as Record<string, unknown>;
    const image = String(policy.image ?? "alpine:3.21");
    const run = Bun.spawnSync([
      dockerCommand,
      ...(await sandboxArgs(worktreePath, handle, project.id, policy)),
      image,
      "sleep",
      "infinity",
    ]);
    if (run.exitCode === 0) {
      sandboxId = run.stdout.toString().trim();
      sandboxState = "Running";
    }
  }
  const workspace = await pb.collection("workspaces").create({
    projectId: project.id,
    roleId: role.id,
    handle,
    label: input.label,
    branch: input.branch,
    baseBranch: project.defaultBranch,
    worktreePath,
    sandboxId,
    sandboxState,
    gitStatus: "Unknown",
    lastActivity: new Date().toISOString(),
  });
  if (roleCredential)
    await pb.collection("workspace_credentials").update(roleCredential.id, { lastUsed: new Date().toISOString() });
  await audit(user?.id ?? String(roleCredential?.id), "create_workspace", workspace.id, { agentCreated });
  return c.json({ ...json(workspace), handle }, 201);
};
app.post("/api/projects/:id/workspaces", createWorkspace);
// Harness callers use the versioned contract; administrators use the management route above.
app.post("/api/v1/projects/:id/workspaces", createWorkspace);
app.post("/api/roles/:id/credentials", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  const secret = `spws_${token()}`;
  const credential = await pb.collection("workspace_credentials").create({
    roleId: c.req.param("id"),
    name: input.name,
    tokenHash: await sha256(secret),
    revoked: false,
    lastUsed: "",
  });
  await audit(user.id, "create_workspace_credential", credential.id);
  return c.json({ credential: json(credential), secret }, 201);
});
app.post("/api/workspaces/:id/start", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  if (workspace.sandboxState === "Running") return c.json(workspace);
  const project = await one("projects", String(workspace.projectId));
  const role = await one("roles", String(workspace.roleId));
  const policy = (role.sandboxPolicy ?? project.sandboxDefaults ?? {}) as Record<string, unknown>;
  const result = Bun.spawnSync([
    dockerCommand,
    ...(await sandboxArgs(String(workspace.worktreePath), String(workspace.handle), project.id, policy)),
    String(policy.image ?? "alpine:3.21"),
    "sleep",
    "infinity",
  ]);
  if (result.exitCode !== 0) return c.json({ error: result.stderr.toString() }, 422);
  const updated = await pb
    .collection("workspaces")
    .update(workspace.id, { sandboxId: result.stdout.toString().trim(), sandboxState: "Running" });
  await audit(user.id, "start_workspace", workspace.id);
  return c.json(json(updated));
});
app.post("/api/workspaces/:id/stop", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  if (workspace.sandboxId) Bun.spawnSync([dockerCommand, "rm", "-f", String(workspace.sandboxId)]);
  const updated = await pb.collection("workspaces").update(workspace.id, { sandboxId: "", sandboxState: "Stopped" });
  await audit(user.id, "stop_workspace", workspace.id);
  return c.json(json(updated));
});
async function releaseWorkspace(workspace: RecordData) {
  const path = assertWorkspacePath(String(workspace.worktreePath));
  const project = await one("projects", String(workspace.projectId));
  if (workspace.sandboxId) Bun.spawnSync([dockerCommand, "rm", "-f", String(workspace.sandboxId)], { timeout: 60_000 });
  if (project.repository) {
    const repositoryPath = `${workspaceRoot()}/repositories/${project.id}.git`;
    const result = Bun.spawnSync(["git", "--git-dir", repositoryPath, "worktree", "remove", "--force", path], {
      timeout: 60_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "Unable to remove Git worktree");
  } else {
    const result = Bun.spawnSync(["rmdir", path], { timeout: 60_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || "Unable to remove local workspace");
  }
  await pb.collection("workspaces").delete(workspace.id);
}
app.post("/api/workspaces/:id/release", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  try {
    await releaseWorkspace(workspace);
    await audit(user.id, "release_workspace", workspace.id);
    return c.body(null, 204);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Workspace release failed" }, 422);
  }
});
app.delete("/api/workspaces/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  try {
    await releaseWorkspace(workspace);
    await audit(user.id, "release_workspace", workspace.id);
    return c.body(null, 204);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Workspace release failed" }, 422);
  }
});
app.delete("/api/projects/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const project = await one("projects", c.req.param("id"));
  const workspaces = await list("workspaces", `projectId="${project.id}"`);
  if (workspaces.length) return c.json({ error: "Release all workspaces before deleting this project" }, 409);
  const roles = await list("roles", `projectId="${project.id}"`);
  await Promise.all(roles.map((role) => pb.collection("roles").delete(role.id)));
  await pb.collection("projects").delete(project.id);
  await audit(user.id, "delete_project", project.id);
  return c.body(null, 204);
});

async function authorizedAgent(header?: string) {
  const raw = header?.replace(/^Bearer\s+/i, "") ?? "";
  const credential = (await list("agent_credentials", `tokenHash="${await sha256(raw)}"`))[0];
  if (!credential || credential.revoked) return null;
  const agent = await one("agents", String(credential.agentId));
  return agent.enabled ? { credential, agent } : null;
}
async function invokeAgentTool(credential: RecordData, exposedName: string, input: Record<string, unknown>) {
  const tool = (await list("agent_tools", `agentId="${credential.agentId}" && exposedName="${exposedName}"`))[0];
  if (!tool) throw new Error("Tool not authorized");
  const provider = await one("providers", String(tool.providerId));
  if (provider.disabled || provider.status === "Unavailable") throw new Error("Provider unavailable");
  validateAdapter(input, tool.inputSchema as Record<string, any>);
  const mapped = mapAdapterInput(input, tool);
  const output = await invokeProvider(provider, String(tool.operation), mapped);
  await pb.collection("agent_credentials").update(credential.id, { lastUsed: new Date().toISOString() });
  return mappedOutput(output, tool.outputMap as Record<string, string>);
}
function agentOpenApiContract(agent: RecordData, tools: RecordData[], origin: string) {
  const paths = Object.fromEntries(
    tools.map((tool) => [
      `/tools/${encodeURIComponent(String(tool.exposedName))}`,
      {
        post: {
          operationId: tool.exposedName,
          summary: tool.description,
          security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: tool.inputSchema || {} } } },
          responses: { 200: { description: "Tool result" } },
        },
      },
    ]),
  );
  return {
    openapi: "3.1.0",
    info: { title: `${agent.name} tools`, version: "1.0.0" },
    servers: [{ url: `${origin}/api/v1` }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}
// Stateless harness endpoint. It accepts only an agent credential, never a web session.
app.post("/api/v1/resolve/:tool", async (c) => {
  const authorized = await authorizedAgent(c.req.header("Authorization"));
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json({
      tool: c.req.param("tool"),
      output: await invokeAgentTool(authorized.credential, c.req.param("tool"), await c.req.json()),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Tool invocation failed" }, 422);
  }
});
app.post("/api/v1/tools/:tool", async (c) => {
  const authorized = await authorizedAgent(c.req.header("Authorization"));
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);
  try {
    return c.json({ output: await invokeAgentTool(authorized.credential, c.req.param("tool"), await c.req.json()) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Tool invocation failed" }, 422);
  }
});
app.get("/api/v1/agents/:id/openapi.json", async (c) => {
  const authorized = await authorizedAgent(c.req.header("Authorization"));
  if (!authorized || authorized.agent.id !== c.req.param("id")) return c.json({ error: "Unauthorized" }, 401);
  return c.json(
    agentOpenApiContract(
      authorized.agent,
      await list("agent_tools", `agentId="${authorized.agent.id}"`),
      new URL(c.req.url).origin,
    ),
  );
});
app.post("/api/v1/mcp", async (c) => {
  const request = (await c.req.json()) as { id?: string | number; method?: string; params?: Record<string, any> };
  const respond = (result?: unknown, error?: { code: number; message: string }) =>
    c.json({ jsonrpc: "2.0", id: request.id ?? null, ...(error ? { error } : { result }) });
  const authorized = await authorizedAgent(c.req.header("Authorization"));
  if (!authorized) return respond(undefined, { code: -32001, message: "Unauthorized" });
  if (request.method === "initialize")
    return respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "subpolar", version: "1.0.0" },
    });
  if (request.method === "tools/list") {
    const tools = await list("agent_tools", `agentId="${authorized.agent.id}"`);
    return respond({
      tools: tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.description,
        inputSchema: tool.inputSchema || {},
      })),
    });
  }
  if (request.method === "tools/call") {
    try {
      const output = await invokeAgentTool(
        authorized.credential,
        String(request.params?.name ?? ""),
        request.params?.arguments ?? {},
      );
      return respond({ content: [{ type: "text", text: JSON.stringify(output) }] });
    } catch (error) {
      return respond(undefined, {
        code: -32002,
        message: error instanceof Error ? error.message : "Tool invocation failed",
      });
    }
  }
  return respond(undefined, { code: -32601, message: "Method not found" });
});
async function authorizedWorkspace(c: Context, capability: string) {
  const scoped = await workspaceForCredential(c);
  if (!scoped) return null;
  const role = await one("roles", String(scoped.workspace.roleId));
  if (!(role.capabilities as string[]).includes(capability) || scoped.workspace.sandboxState !== "Running") return null;
  await pb.collection("workspace_credentials").update(scoped.credential.id, { lastUsed: new Date().toISOString() });
  return scoped.workspace;
}
app.post("/api/v1/workspaces/:handle/release", async (c) => {
  const scoped = await workspaceForCredential(c);
  if (!scoped) return c.json({ error: "Unauthorized" }, 401);
  const role = await one("roles", String(scoped.workspace.roleId));
  if (!(role.capabilities as string[]).includes("workspace.cleanup")) return c.json({ error: "Unauthorized" }, 401);
  try {
    await releaseWorkspace(scoped.workspace);
    await pb.collection("workspace_credentials").update(scoped.credential.id, { lastUsed: new Date().toISOString() });
    await audit(scoped.credential.id, "release_workspace", scoped.workspace.id, { agentCreated: true });
    return c.body(null, 204);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Workspace release failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/tools/:tool", async (c) => {
  const workspace = await authorizedWorkspace(c, "external.tools");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  const tool = (await list("role_tools", `roleId="${workspace.roleId}" && exposedName="${c.req.param("tool")}"`))[0];
  if (!tool) return c.json({ error: "Tool not authorized" }, 404);
  try {
    const input = await c.req.json();
    validateAdapter(input, tool.inputSchema as Record<string, any>);
    const mapped = mapAdapterInput(input, tool);
    const output = await invokeProvider(
      await one("providers", String(tool.providerId)),
      String(tool.operation),
      mapped,
    );
    return c.json({ output: mappedOutput(output, tool.outputMap as Record<string, string>) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Tool invocation failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/files/read", async (c) => {
  const workspace = await authorizedWorkspace(c, "filesystem.read");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  try {
    const { path } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
    return c.json({ path, content: await Bun.file(safeWorkspacePath(String(workspace.worktreePath), path)).text() });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Read failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/files/write", async (c) => {
  const workspace = await authorizedWorkspace(c, "filesystem.write");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  try {
    const { path, content } = z.object({ path: z.string().min(1), content: z.string() }).parse(await c.req.json());
    const target = safeWorkspacePath(String(workspace.worktreePath), path);
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (parent) commandOutput(["mkdir", "-p", parent]);
    await Bun.write(target, content);
    await pb.collection("workspaces").update(workspace.id, { lastActivity: new Date().toISOString() });
    return c.json({ path, bytes: content.length });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Write failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/files/search", async (c) => {
  const workspace = await authorizedWorkspace(c, "filesystem.search");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  const { query, path } = z
    .object({ query: z.string().min(1).max(500), path: z.string().default(".") })
    .parse(await c.req.json());
  try {
    const result = Bun.spawnSync(
      ["rg", "--json", "--max-count", "100", query, safeWorkspacePath(String(workspace.worktreePath), path)],
      { timeout: 60_000 },
    );
    return c.json({ exitCode: result.exitCode, matches: result.stdout.toString() });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Search failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/shell", async (c) => {
  const workspace = await authorizedWorkspace(c, "shell.execute");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  const { command } = z.object({ command: z.string().min(1).max(10000) }).parse(await c.req.json());
  const role = await one("roles", String(workspace.roleId));
  const result = Bun.spawnSync([dockerCommand, "exec", String(workspace.sandboxId), "sh", "-lc", command], {
    timeout: workspaceTimeout((role.sandboxPolicy ?? {}) as Record<string, unknown>),
  });
  await pb.collection("workspaces").update(workspace.id, { lastActivity: new Date().toISOString() });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() });
});
app.post("/api/v1/workspaces/:handle/git/:operation", async (c) => {
  const operation = c.req.param("operation");
  const capability = `git.${operation}`;
  const workspace = await authorizedWorkspace(c, capability);
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  if (!(["status", "diff", "log", "branch", "commit", "fetch", "pull", "push"] as string[]).includes(operation))
    return c.json({ error: "Unsupported Git operation" }, 404);
  const input =
    operation === "commit" ? z.object({ message: z.string().min(1).max(500) }).parse(await c.req.json()) : {};
  try {
    const result = await workspaceGit(
      workspace,
      operation as Parameters<typeof workspaceGit>[1],
      "message" in input && typeof input.message === "string" ? input.message : undefined,
    );
    return c.json(result, result.exitCode === 0 ? 200 : 422);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Git operation failed" }, 422);
  }
});
app.post("/api/v1/workspaces/:handle/pull-requests", async (c) => {
  const workspace = await authorizedWorkspace(c, "pull_request.create");
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  const input = z
    .object({ title: z.string().min(1).max(255), body: z.string().max(10000).default("") })
    .parse(await c.req.json());
  const project = await one("projects", String(workspace.projectId));
  const integration = ((project.sandboxDefaults ?? {}) as Record<string, any>).gitIntegration as
    { baseUrl?: string; credentialId?: string } | undefined;
  if (!integration?.baseUrl || !integration.credentialId)
    return c.json({ error: "Project Git integration is not configured" }, 422);
  const credential = await one("credentials", integration.credentialId);
  const accessToken = await decryptSecret(String(credential.ciphertext));
  const repository = String(project.repository).replace(/\.git$/, "");
  const match = repository.match(/(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+?)\/?$/);
  if (!match) return c.json({ error: "Repository URL cannot be parsed" }, 422);
  const path = match[1];
  const headers = {
    ...gitHeaders(project.gitProvider as GitProvider, accessToken),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  let response: Response;
  if (project.gitProvider === "GitLab")
    response = await fetch(`${integration.baseUrl}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: input.title,
        description: input.body,
        source_branch: workspace.branch,
        target_branch: project.defaultBranch,
      }),
    });
  else {
    const endpoint =
      project.gitProvider === "Gitea"
        ? `${integration.baseUrl}/api/v1/repos/${path}/pulls`
        : `${integration.baseUrl}/repos/${path}/pulls`;
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: workspace.branch,
        base: project.defaultBranch,
      }),
    });
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return c.json({ error: "Pull-request creation failed", provider: result }, 422);
  return c.json(
    { url: result.html_url ?? result.web_url, number: result.number ?? result.iid, provider: project.gitProvider },
    201,
  );
});
app.post("/api/workspaces/:id/pull-requests", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ title: z.string().min(1).max(255), body: z.string().max(10000).default("") })
    .parse(await c.req.json());
  const workspace = await one("workspaces", c.req.param("id"));
  const project = await one("projects", String(workspace.projectId));
  const integration = ((project.sandboxDefaults ?? {}) as Record<string, any>).gitIntegration as
    { baseUrl?: string; credentialId?: string } | undefined;
  if (!integration?.baseUrl || !integration.credentialId)
    return c.json({ error: `${project.gitProvider} integration is not configured` }, 422);
  const repository = String(project.repository).replace(/\.git$/, "");
  const match = repository.match(/(?:https?:\/\/[^/]+\/|git@[^:]+:)(.+?)\/?$/);
  if (!match) return c.json({ error: "Repository URL cannot be parsed for this Git provider" }, 422);
  const accessToken = await decryptSecret(String((await one("credentials", integration.credentialId)).ciphertext));
  const headers = {
    ...gitHeaders(project.gitProvider as GitProvider, accessToken),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const endpoint =
    project.gitProvider === "GitLab"
      ? `${integration.baseUrl}/api/v4/projects/${encodeURIComponent(match[1])}/merge_requests`
      : project.gitProvider === "Gitea"
        ? `${integration.baseUrl}/api/v1/repos/${match[1]}/pulls`
        : `${integration.baseUrl}/repos/${match[1]}/pulls`;
  const payload =
    project.gitProvider === "GitLab"
      ? {
          title: input.title,
          description: input.body,
          source_branch: workspace.branch,
          target_branch: project.defaultBranch,
        }
      : { title: input.title, body: input.body, head: workspace.branch, base: project.defaultBranch };
  try {
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    const result = await response.json().catch(() => ({}) as Record<string, unknown>);
    if (!response.ok)
      return c.json(
        {
          error: `${project.gitProvider} returned ${response.status}`,
          providerStatus: response.status,
          provider: result,
        },
        422,
      );
    await audit(user.id, "create_pull_request", workspace.id, { provider: project.gitProvider });
    return c.json(
      { url: result.html_url ?? result.web_url, number: result.number ?? result.iid, provider: project.gitProvider },
      201,
    );
  } catch (error) {
    return c.json(
      { error: `${project.gitProvider} request failed: ${error instanceof Error ? error.message : "unknown error"}` },
      422,
    );
  }
});

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

await setup();
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
