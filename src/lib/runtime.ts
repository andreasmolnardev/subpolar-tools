export type Adapter = {
  fixedArgs?: Record<string, unknown>;
  inputMap?: Record<string, string>;
  outputMap?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
};

async function encryptionKey(secret: string, usage: KeyUsage[]) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, usage);
}

export async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret, ["encrypt"]),
    new TextEncoder().encode(value),
  );
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}

export async function decryptSecret(value: string, secret: string) {
  const [ivText, ciphertext] = value.split(".");
  if (!ivText || !ciphertext) throw new Error("Invalid credential ciphertext");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(ivText, "base64url") },
    await encryptionKey(secret, ["decrypt"]),
    Buffer.from(ciphertext, "base64url"),
  );
  return new TextDecoder().decode(plain);
}

export function validateAdapter(input: Record<string, unknown>, schema: Record<string, unknown>) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of required)
    if (typeof field === "string" && input[field] === undefined)
      throw new Error(`Missing required input field: ${field}`);
}

export function mapAdapterInput(input: Record<string, unknown>, adapter: Record<string, unknown> & Adapter) {
  const mapped: Record<string, unknown> = { ...(adapter.fixedArgs ?? {}) };
  for (const [from, to] of Object.entries(adapter.inputMap ?? {})) mapped[to] = input[from];
  return mapped;
}

export function mappedOutput(value: unknown, outputMap: Record<string, string>) {
  if (!Object.keys(outputMap).length) return value;
  const result: Record<string, unknown> = {};
  for (const [visible, source] of Object.entries(outputMap))
    result[visible] = source.split(".").reduce<any>((current, key) => current?.[key], value);
  return result;
}

export function schemaChanged(previous: unknown, current: unknown) {
  return JSON.stringify(previous ?? null) !== JSON.stringify(current);
}

export function safeWorkspacePath(root: string, requested: string) {
  const path = requested.replace(/^\/+/, "");
  if (path.split("/").includes("..") || path.includes("\0")) throw new Error("Path escapes workspace");
  return `${root}/${path}`;
}

export function assertWorkspacePath(root: string, path: string) {
  if (!path.startsWith(`${root}/`) || path.slice(root.length + 1).includes("/.."))
    throw new Error("Workspace path is outside the managed workspace root");
  return path;
}

export function isAdminOrGranted(platformRole: unknown, granted: boolean) {
  return platformRole === "Admin" || granted;
}
