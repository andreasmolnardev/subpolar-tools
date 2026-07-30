const token = process.env.SUBPOLAR_AGENT_TOKEN;
const apiOrigin = process.env.SUBPOLAR_API_URL ?? "http://localhost:3000";
const [command, rawInput, ...extra] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!token) fail("SUBPOLAR_AGENT_TOKEN is required");
if (!URL.canParse(apiOrigin)) fail("SUBPOLAR_API_URL must be a valid URL");
if (!command || extra.length) fail("Usage: subpolar-tools <tool> [json-object-input]");

let input: Record<string, unknown> = {};
if (rawInput !== undefined) {
  try {
    const parsed = JSON.parse(rawInput);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    input = parsed;
  } catch {
    fail("Tool input must be a valid JSON object");
  }
}

const path = command === "get" ? "/api/v1/mcp" : `/api/v1/tools/${encodeURIComponent(command)}`;
const body =
  command === "get"
    ? { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    : input;
const response = await fetch(new URL(path, apiOrigin), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const result = (await response.json().catch(() => ({}))) as Record<string, any>;
if (!response.ok || result.error) fail(result.error?.message ?? result.error ?? `Request failed (${response.status})`);
console.log(JSON.stringify(command === "get" ? result.result?.tools ?? [] : result.output, null, 2));

export {};
