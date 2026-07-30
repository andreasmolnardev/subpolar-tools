const json = (value: unknown, status = 200) => Response.json(value, { status });

Bun.serve({
  port: 4010,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/weather/"))
      return json({ result: { temperature: `weather:${decodeURIComponent(url.pathname.slice("/weather/".length))}` } });
    if (request.method !== "POST" || url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return request.json().then((body: { id?: string | number; method?: string; params?: Record<string, any> }) => {
      const result =
        body.method === "initialize"
          ? { protocolVersion: "2024-11-05", serverInfo: { name: "http-fixture", version: "1" } }
          : body.method === "tools/list"
            ? { tools: [{ name: "http.echo", description: "Echoes arguments", inputSchema: { type: "object" } }] }
            : body.method === "tools/call"
              ? { echo: body.params?.arguments, transport: "http" }
              : undefined;
      return json({ jsonrpc: "2.0", id: body.id ?? null, result });
    });
  },
});
