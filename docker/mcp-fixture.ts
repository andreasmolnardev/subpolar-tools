import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, any> };
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2024-11-05", serverInfo: { name: "stdio-fixture", version: "1" } }
        : request.method === "tools/list"
          ? { tools: [{ name: "stdio.echo", description: "Echoes arguments", inputSchema: { type: "object" } }] }
          : request.method === "tools/call"
            ? { echo: request.params?.arguments, transport: "stdio" }
            : undefined;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  } catch {
    // The fixture only needs to serve valid JSON-RPC requests from the integration suite.
  }
}
