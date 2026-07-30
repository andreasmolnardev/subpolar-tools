import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import PocketBase from "pocketbase";
import { z } from "zod";

const pbUrl = process.env.PB_URL ?? "http://127.0.0.1:8090";
const pb = new PocketBase(pbUrl);
const app = new Hono();
const adminEmail = process.env.SUBPOLAR_ADMIN_EMAIL ?? "admin@example.com";
const adminPassword = process.env.SUBPOLAR_ADMIN_PASSWORD ?? "development-only-password";
const rateWindows = new Map<string, { started: number; count: number }>();

type RecordData = Record<string, unknown> & { id: string; created: string; updated: string };
const json = <T>(value: T) => JSON.parse(JSON.stringify(value)) as T;
const sha256 = async (value: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
const token = () => crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url", omitPadding: true });
async function encryptSecret(value: string) {
  // The deployment secret is kept outside PocketBase so a database backup alone cannot reveal provider credentials.
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(process.env.SUBPOLAR_SECRET_KEY ?? adminPassword),
  );
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}
async function decryptSecret(value: string) {
  const [ivText, ciphertext] = value.split(".");
  if (!ivText || !ciphertext) throw new Error("Invalid credential ciphertext");
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(process.env.SUBPOLAR_SECRET_KEY ?? adminPassword),
  );
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(ivText, "base64url") },
    key,
    Buffer.from(ciphertext, "base64url"),
  );
  return new TextDecoder().decode(plain);
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
  ]);
  await ensureCollection("audit_events", "base", [
    text("actorId"),
    text("action"),
    text("resource"),
    jsonField("details"),
  ]);
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
  await pb.collection("audit_events").create({ actorId, action, resource, details });
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
const list = async (collection: string, filter = "") =>
  json(
    await pb.collection(collection).getFullList({ filter: filter.replace(/([A-Za-z0-9_])=/g, "$1 = ") }),
  ) as RecordData[];
const one = async (collection: string, id: string) => json(await pb.collection(collection).getOne(id)) as RecordData;
function rateLimited(c: Context, bucket: string, limit = 5, windowMs = 60_000) {
  const key = `${bucket}:${c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "local"}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || now - current.started > windowMs) {
    rateWindows.set(key, { started: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}
const configOf = (record: RecordData) => (record.configuration ?? {}) as Record<string, unknown>;

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
async function mcpStdio(provider: RecordData, requests: Array<{ method: string; params: object }>) {
  const command = configOf(provider).command;
  if (!Array.isArray(command) || !command.length || !command.every((part) => typeof part === "string"))
    throw new Error("MCP command transport requires configuration.command as a non-empty command array");
  const process = Bun.spawn({ cmd: command as string[], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const [index, request] of requests.entries())
    process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request })}\n`);
  process.stdin.end();
  const timeout = Number(configOf(provider).timeout ?? 10000);
  const completed = await Promise.race([
    Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        process.kill();
        reject(new Error("MCP command timed out"));
      }, timeout),
    ),
  ]);
  const [stdout, stderr, exitCode] = completed;
  if (exitCode !== 0) throw new Error(stderr || `MCP command exited with ${exitCode}`);
  const responses = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: number; result?: any; error?: { message: string } });
  return requests.map(
    (_, index) =>
      responses.find((response) => response.id === index + 1) ?? {
        error: { message: "MCP command returned no response" },
      },
  );
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
    const response = await fetch(String(configuration.schemaUrl ?? provider.endpoint), {
      headers,
      signal: AbortSignal.timeout(Number(configuration.timeout ?? 10000)),
    });
    if (!response.ok) throw new Error(`Schema request failed with ${response.status}`);
    const document = (await response.json()) as Record<string, any>;
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
  const changed = JSON.stringify(prior?.current ?? null) !== JSON.stringify(current);
  return await pb.collection("providers").update(provider.id, {
    schema: { current, previous: prior?.current ?? null, changed, discoveredAt: new Date().toISOString() },
    status: "Available",
    lastConnected: new Date().toISOString(),
  });
}
function validateAdapter(input: Record<string, unknown>, schema: Record<string, any>) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required)
    if (input[field] === undefined) throw new Error(`Missing required input field: ${field}`);
}
function mappedOutput(value: unknown, outputMap: Record<string, string>) {
  if (!Object.keys(outputMap).length) return value;
  const result: Record<string, unknown> = {};
  for (const [visible, source] of Object.entries(outputMap))
    result[visible] = source.split(".").reduce<any>((current, key) => current?.[key], value);
  return result;
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
function safeWorkspacePath(root: string, requested: string) {
  const path = requested.replace(/^\/+/, "");
  if (path.split("/").includes("..") || path.includes("\0")) throw new Error("Path escapes workspace");
  return `${root}/${path}`;
}
function commandOutput(command: string[], timeout = 60000) {
  const process = Bun.spawnSync(command, { timeout });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString() || `Command failed with ${process.exitCode}`);
  return process.stdout.toString();
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
  if (rateLimited(c, "sign-in", 10)) return c.json({ error: "Too many attempts; try again shortly" }, 429);
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await c.req.json());
  try {
    const auth = await new PocketBase(pbUrl).collection("platform_users").authWithPassword(input.email, input.password);
    if (auth.record.enabled === false) return c.json({ error: "Invalid email or password" }, 401);
    const sessionToken = `sps_${token()}`;
    await pb.collection("sessions").create({
      userId: auth.record.id,
      tokenHash: await sha256(sessionToken),
      label: c.req.header("user-agent")?.slice(0, 120) ?? "Browser",
      lastUsed: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      revoked: false,
    });
    await audit(auth.record.id, "sign_in", "session");
    return c.json({ token: sessionToken, user: json(auth.record) });
  } catch {
    return c.json({ error: "Invalid email or password" }, 401);
  }
});
app.post("/api/auth/forgot-password", async (c) => {
  if (rateLimited(c, "password-reset", 5, 15 * 60_000)) return c.json({ ok: true });
  const input = z.object({ email: z.string().email() }).parse(await c.req.json());
  try {
    await pb.collection("platform_users").requestPasswordReset(input.email);
  } catch {
    /* Do not reveal account existence. */
  }
  return c.json({ ok: true });
});
app.post("/api/auth/reset-password", async (c) => {
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
app.get("/api/audit-events", async (c) => {
  if (!(await requireUser(c, true))) return c.json({ error: "Forbidden" }, 403);
  return c.json((await list("audit_events")).slice(0, 100));
});

app.get("/api/providers", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await list("providers"));
});
app.post("/api/providers", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      name: z.string().min(1),
      kind: z.enum(["MCP", "OpenAPI"]),
      endpoint: z.string().min(1),
      configuration: z.record(z.unknown()).default({}),
      schema: z.record(z.unknown()).default({}),
      credentialName: z.string().optional(),
      credentialSecret: z.string().optional(),
    })
    .parse(await c.req.json());
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
  const provider = await pb
    .collection("providers")
    .create({ ...input, credentialId, status: "Unknown", disabled: false, lastConnected: "" });
  await audit(user.id, "create_provider", provider.id);
  return c.json(json(provider), 201);
});
app.post("/api/providers/:id/test", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const provider = await one("providers", c.req.param("id"));
  try {
    const updated = await discover(provider);
    await audit(user.id, "test_provider", provider.id, { status: "Available" });
    return c.json(json(updated));
  } catch (error) {
    const updated = await pb.collection("providers").update(provider.id, { status: "Unavailable" });
    await audit(user.id, "test_provider", provider.id, { status: "Unavailable" });
    return c.json(
      { provider: json(updated), error: error instanceof Error ? error.message : "Provider test failed" },
      422,
    );
  }
});
app.post("/api/providers/:id/refresh", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const updated = await discover(await one("providers", c.req.param("id")));
  await audit(user.id, "refresh_provider", updated.id);
  return c.json(json(updated));
});
app.patch("/api/providers/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({
      disabled: z.boolean().optional(),
      name: z.string().min(1).optional(),
      schema: z.record(z.unknown()).optional(),
    })
    .parse(await c.req.json());
  const updated = await pb.collection("providers").update(c.req.param("id"), input);
  await audit(user.id, "update_provider", updated.id, input);
  return c.json(json(updated));
});
app.delete("/api/providers/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const provider = await one("providers", c.req.param("id"));
  const tools = await list("agent_tools", `providerId="${provider.id}"`);
  if (tools.length)
    return c.json({ error: "Provider is still used by agent tools; disable it or remove those tools first" }, 409);
  if (provider.credentialId) await pb.collection("credentials").delete(String(provider.credentialId));
  await pb.collection("providers").delete(provider.id);
  await audit(user.id, "delete_provider", provider.id);
  return c.body(null, 204);
});

app.get("/api/agents", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  const agents = await list("agents");
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
    const mapped: Record<string, unknown> = { ...(tool.fixedArgs as object) };
    for (const [from, to] of Object.entries(tool.inputMap as Record<string, string>)) mapped[to] = input[from];
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
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  const agent = await one("agents", c.req.param("id"));
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
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  const [projects, roles, workspaces] = await Promise.all([list("projects"), list("roles"), list("workspaces")]);
  return c.json(
    projects.map((project) => ({
      ...project,
      roleCount: roles.filter((role) => role.projectId === project.id).length,
      workspaceCount: workspaces.filter((workspace) => workspace.projectId === project.id).length,
    })),
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
      ],
      toolIds: [],
      sandboxPolicy: input.sandboxDefaults,
      maxWorkspaces: 5,
    });
  await audit(user.id, "create_project", project.id);
  return c.json(json(project), 201);
});
app.get("/api/projects/:id/roles", async (c) => {
  if (!(await requireUser(c))) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await list("roles", `projectId="${c.req.param("id")}"`));
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
    })
    .parse(await c.req.json());
  const role = await pb.collection("roles").create({ ...input, projectId: c.req.param("id"), toolIds: [] });
  return c.json(json(role), 201);
});
app.post("/api/projects/:id/git-credential", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const project = await one("projects", c.req.param("id"));
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
  await audit(user.id, "configure_git_credential", project.id);
  return c.json({ project: json(updated), credential: { id: credential.id, name: credential.name } });
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
    ? Bun.spawnSync(["docker", "inspect", "--format", "{{.State.Status}}", String(workspace.sandboxId)])
    : null;
  return c.json({
    ...workspace,
    gitStatus,
    diff,
    sandboxState: docker?.exitCode === 0 ? docker.stdout.toString().trim() : workspace.sandboxState,
  });
});
app.post("/api/projects/:id/workspaces", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const input = z
    .object({ roleId: z.string(), label: z.string().min(1), branch: z.string().min(1) })
    .parse(await c.req.json());
  const role = await one("roles", input.roleId);
  const active = await list("workspaces", `roleId="${role.id}"`);
  if (active.length >= Number(role.maxWorkspaces)) return c.json({ error: "Role workspace limit reached" }, 409);
  const project = await one("projects", c.req.param("id"));
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
  const policy = (role.sandboxPolicy ?? project.sandboxDefaults ?? {}) as Record<string, unknown>;
  const image = String(policy.image ?? "alpine:3.21");
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
    image,
    "sleep",
    "infinity",
  ];
  const run = Bun.spawnSync(["docker", ...args]);
  if (run.exitCode === 0) {
    sandboxId = run.stdout.toString().trim();
    sandboxState = "Running";
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
  });
  await audit(user.id, "create_workspace", workspace.id);
  return c.json({ ...json(workspace), handle }, 201);
});
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
    "docker",
    "run",
    "-d",
    "--rm",
    "--name",
    `subpolar-${workspace.handle}`,
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
    `${workspace.worktreePath}:/workspace`,
    "-w",
    "/workspace",
    "--network",
    policy.network ? "bridge" : "none",
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
  if (workspace.sandboxId) Bun.spawnSync(["docker", "rm", "-f", String(workspace.sandboxId)]);
  const updated = await pb.collection("workspaces").update(workspace.id, { sandboxId: "", sandboxState: "Stopped" });
  await audit(user.id, "stop_workspace", workspace.id);
  return c.json(json(updated));
});
app.delete("/api/workspaces/:id", async (c) => {
  const user = await requireUser(c, true);
  if (!user) return c.json({ error: "Forbidden" }, 403);
  const workspace = await one("workspaces", c.req.param("id"));
  if (workspace.sandboxId) Bun.spawnSync(["docker", "rm", "-f", String(workspace.sandboxId)]);
  if (workspace.worktreePath) Bun.spawnSync(["rm", "-rf", String(workspace.worktreePath)]);
  await pb.collection("workspaces").delete(workspace.id);
  await audit(user.id, "delete_workspace", workspace.id);
  return c.body(null, 204);
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

// Stateless harness endpoint. It accepts only an agent credential, never a web session.
app.post("/api/v1/resolve/:tool", async (c) => {
  const raw = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const credential = (await list("agent_credentials", `tokenHash="${await sha256(raw)}"`))[0];
  if (!credential || credential.revoked) return c.json({ error: "Unauthorized" }, 401);
  const tool = (
    await list("agent_tools", `agentId="${credential.agentId}" && exposedName="${c.req.param("tool")}"`)
  )[0];
  if (!tool) return c.json({ error: "Tool not authorized" }, 403);
  const agent = await one("agents", String(credential.agentId));
  if (!agent.enabled) return c.json({ error: "Agent profile disabled" }, 403);
  const provider = await one("providers", String(tool.providerId));
  if (provider.disabled || provider.status === "Unavailable") return c.json({ error: "Provider unavailable" }, 503);
  try {
    const input = (await c.req.json()) as Record<string, unknown>;
    validateAdapter(input, tool.inputSchema as Record<string, any>);
    const mapped: Record<string, unknown> = { ...(tool.fixedArgs as object) };
    for (const [from, to] of Object.entries(tool.inputMap as Record<string, string>)) mapped[to] = input[from];
    const output = await invokeProvider(provider, String(tool.operation), mapped);
    await pb.collection("agent_credentials").update(credential.id, { lastUsed: new Date().toISOString() });
    return c.json({ tool: tool.exposedName, output: mappedOutput(output, tool.outputMap as Record<string, string>) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Tool invocation failed" }, 422);
  }
});

async function authorizedWorkspace(c: Context, capability: string) {
  const scoped = await workspaceForCredential(c);
  if (!scoped) return null;
  const role = await one("roles", String(scoped.workspace.roleId));
  if (!(role.capabilities as string[]).includes(capability) || scoped.workspace.sandboxState !== "Running") return null;
  await pb.collection("workspace_credentials").update(scoped.credential.id, { lastUsed: new Date().toISOString() });
  return scoped.workspace;
}
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
    await Bun.write(target, content);
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
  const result = Bun.spawnSync(["docker", "exec", String(workspace.sandboxId), "sh", "-lc", command], {
    timeout: 600000,
  });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() });
});
app.post("/api/v1/workspaces/:handle/git/:operation", async (c) => {
  const operation = c.req.param("operation");
  const capability = `git.${operation}`;
  const workspace = await authorizedWorkspace(c, capability);
  if (!workspace) return c.json({ error: "Unauthorized" }, 401);
  const accepted: Record<string, string[]> = {
    status: ["status", "--short"],
    diff: ["diff"],
    log: ["log", "--oneline", "-20"],
    branch: ["branch", "--show-current"],
    fetch: ["fetch"],
    pull: ["pull", "--ff-only"],
    push: ["push"],
  };
  let args = accepted[operation];
  if (operation === "commit") {
    const { message } = z.object({ message: z.string().min(1).max(500) }).parse(await c.req.json());
    args = ["commit", "-m", message];
  }
  if (!args) return c.json({ error: "Unsupported Git operation" }, 404);
  const result = Bun.spawnSync(["git", "-C", String(workspace.worktreePath), ...args], { timeout: 60000 });
  return c.json({ exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() });
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
    Authorization: `Bearer ${accessToken}`,
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

app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

await setup();
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
