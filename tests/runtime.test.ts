import { expect, test } from "bun:test";
import {
  assertWorkspacePath,
  decryptSecret,
  encryptSecret,
  isAdminOrGranted,
  mapAdapterInput,
  mappedOutput,
  safeWorkspacePath,
  schemaChanged,
  validateAdapter,
} from "../packages/runtime/src";

test("adapter mapping preserves hidden arguments and exposes selected output", () => {
  const adapter = {
    fixedArgs: { tenant: "internal", pageSize: 10 },
    inputMap: { query: "q", region: "filters.region" },
    outputMap: { answer: "data.answer", total: "data.meta.total" },
  };
  const input = { query: "polar research", region: "arctic" };
  validateAdapter(input, { required: ["query"] });
  expect(mapAdapterInput(input, adapter)).toEqual({
    tenant: "internal",
    pageSize: 10,
    q: "polar research",
    "filters.region": "arctic",
  });
  expect(mappedOutput({ data: { answer: "ice", meta: { total: 1 } } }, adapter.outputMap)).toEqual({
    answer: "ice",
    total: 1,
  });
  expect(() => validateAdapter({}, { required: ["query"] })).toThrow("Missing required input field: query");
});

test("credentials are randomized, authenticated, and bound to their deployment secret", async () => {
  const encrypted = await encryptSecret("provider-token", "test-key-one");
  expect(encrypted).not.toContain("provider-token");
  expect(await decryptSecret(encrypted, "test-key-one")).toBe("provider-token");
  expect(decryptSecret(encrypted, "test-key-two")).rejects.toThrow();
  expect(decryptSecret("not-a-ciphertext", "test-key-one")).rejects.toThrow("Invalid credential ciphertext");
});

test("authorization grants only administrators or explicit grantees", () => {
  expect(isAdminOrGranted("Admin", false)).toBe(true);
  expect(isAdminOrGranted("User", true)).toBe(true);
  expect(isAdminOrGranted("User", false)).toBe(false);
});

test("schema changes distinguish identical snapshots from provider changes", () => {
  const schema = { operations: [{ operationId: "weather", inputSchema: { type: "object" } }] };
  expect(schemaChanged(schema, structuredClone(schema))).toBe(false);
  expect(schemaChanged(schema, { operations: [{ operationId: "weather-v2" }] })).toBe(true);
});

test("workspace paths cannot escape their managed root", () => {
  expect(safeWorkspacePath("/workspaces/a", "/src/index.ts")).toBe("/workspaces/a/src/index.ts");
  expect(() => safeWorkspacePath("/workspaces/a", "../b/secret")).toThrow("Path escapes workspace");
  expect(() => safeWorkspacePath("/workspaces/a", "src/../../b/secret")).toThrow("Path escapes workspace");
  expect(() => safeWorkspacePath("/workspaces/a", "file\0name")).toThrow("Path escapes workspace");
  expect(assertWorkspacePath("/workspaces", "/workspaces/a")).toBe("/workspaces/a");
  expect(() => assertWorkspacePath("/workspaces", "/workspaces-other/a")).toThrow("outside the managed workspace root");
});
