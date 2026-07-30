import { useEffect, useState, type FormEvent } from "react";
import { Bot, KeyRound, Play, Plus, Power, Trash2, Wrench } from "lucide-react";
import { Button } from "../components/ui/button";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function AgentsPage({ request }: { request: Request }) {
  const [agents, setAgents] = useState<RecordItem[]>([]);
  const [providers, setProviders] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [tools, setTools] = useState<RecordItem[]>([]);
  const [contract, setContract] = useState<RecordItem | null>(null);
  const [secret, setSecret] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showTool, setShowTool] = useState(false);
  const [testOutput, setTestOutput] = useState("");

  const load = async () => {
    const [nextAgents, nextProviders] = await Promise.all([request("/api/agents"), request("/api/providers")]);
    setAgents(nextAgents);
    setProviders(nextProviders);
  };
  const select = async (agent: RecordItem) => {
    setSelected(agent);
    const [nextTools, nextContract] = await Promise.all([
      request(`/api/agents/${agent.id}/tools`),
      request(`/api/agents/${agent.id}/contract`),
    ]);
    setTools(nextTools);
    setContract(nextContract);
  };
  useEffect(() => {
    void load();
  }, []);

  const createAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const agent = await request("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), description: form.get("description") }),
    });
    setShowCreate(false);
    await load();
    await select(agent);
  };
  const addTool = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await request(`/api/agents/${selected.id}/tools`, {
      method: "POST",
      body: JSON.stringify({
        providerId: form.get("providerId"),
        operation: form.get("operation"),
        exposedName: form.get("exposedName"),
        description: form.get("description"),
        inputSchema: JSON.parse(String(form.get("inputSchema") || "{}")),
        inputMap: JSON.parse(String(form.get("inputMap") || "{}")),
        fixedArgs: JSON.parse(String(form.get("fixedArgs") || "{}")),
        outputMap: JSON.parse(String(form.get("outputMap") || "{}")),
      }),
    });
    setShowTool(false);
    await select(selected);
    await load();
  };
  const createCredential = async () => {
    if (!selected) return;
    const result = await request(`/api/agents/${selected.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({ name: "Admin console" }),
    });
    setSecret(result.secret);
  };
  const toggle = async () => {
    if (!selected) return;
    const updated = await request(`/api/agents/${selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !selected.enabled }),
    });
    await load();
    setSelected(updated);
  };
  const removeTool = async (tool: RecordItem) => {
    if (!selected || !confirm(`Remove ${tool.exposedName}?`)) return;
    await request(`/api/agents/${selected.id}/tools/${tool.id}`, { method: "DELETE" });
    await select(selected);
  };
  const testTool = async (tool: RecordItem) => {
    if (!selected) return;
    const raw = prompt(`JSON input for ${tool.exposedName}`, "{}");
    if (raw === null) return;
    const result = await request(`/api/agents/${selected.id}/tools/${tool.id}/test`, { method: "POST", body: raw });
    setTestOutput(JSON.stringify(result, null, 2));
  };

  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="mt-1 text-sm text-slate-400">
            Configure stateless model-facing tools and authorization credentials.
          </p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus size={16} className="mr-2" />
          New profile
        </Button>
      </div>
      {showCreate && (
        <form className="mb-6 grid gap-3 rounded-xl border bg-slate-900/60 p-5 md:grid-cols-3" onSubmit={createAgent}>
          <input required name="name" placeholder="Profile name" />
          <input name="description" placeholder="Description" />
          <Button>Create profile</Button>
        </form>
      )}
      {secret && (
        <div className="mb-6 rounded-xl border border-cyan-700 bg-slate-900 p-5">
          <p className="font-medium">Store this credential now. It will not be displayed again.</p>
          <code className="mt-3 block overflow-auto rounded bg-slate-950 p-3 text-cyan-300">{secret}</code>
          <Button className="mt-3" variant="outline" onClick={() => setSecret("")}>
            I stored it
          </Button>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[19rem_1fr]">
        <aside className="space-y-2">
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => void select(agent)}
              className={`w-full rounded-lg border p-4 text-left ${selected?.id === agent.id ? "border-cyan-500 bg-cyan-500/10" : "bg-slate-900/60 hover:bg-slate-900"}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{agent.name}</span>
                <span className="text-xs text-slate-400">{agent.toolCount} tools</span>
              </div>
              <p className="mt-1 truncate text-sm text-slate-500">{agent.description || "No description"}</p>
            </button>
          ))}
          {!agents.length && (
            <p className="rounded-lg border p-4 text-sm text-slate-400">Create a profile to expose provider tools.</p>
          )}
        </aside>
        <section className="min-w-0 rounded-xl border bg-slate-900/60 p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Bot size={18} className="text-cyan-400" />
                    {selected.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">{selected.description || "No description"}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void toggle()}>
                    <Power size={14} className="mr-2" />
                    {selected.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowTool(!showTool)}>
                    <Wrench size={14} className="mr-2" />
                    Expose tool
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void createCredential()}>
                    <KeyRound size={14} className="mr-2" />
                    Credential
                  </Button>
                </div>
              </div>
              {showTool && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-2" onSubmit={addTool}>
                  <select required name="providerId">
                    <option value="">Provider</option>
                    {providers
                      .filter((provider) => !provider.disabled)
                      .map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.kind})
                        </option>
                      ))}
                  </select>
                  <input required name="operation" placeholder="Underlying operation, e.g. query" />
                  <input required name="exposedName" placeholder="Exposed name, e.g. web.search" />
                  <input name="description" placeholder="Model-visible description" />
                  <textarea name="inputSchema" defaultValue="{}" placeholder="Exposed JSON schema" />
                  <textarea name="inputMap" defaultValue="{}" placeholder='Input map, e.g. {"query":"q"}' />
                  <textarea name="fixedArgs" defaultValue="{}" placeholder="Fixed hidden arguments" />
                  <textarea name="outputMap" defaultValue="{}" placeholder="Output map" />
                  <Button className="md:col-span-2">Save adapter</Button>
                </form>
              )}
              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="mb-3 text-sm font-medium text-slate-300">Exposed tools</h3>
                  {tools.length ? (
                    <div className="space-y-2">
                      {tools.map((tool) => (
                        <div key={tool.id} className="rounded-lg border bg-slate-950/60 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium text-cyan-300">{tool.exposedName}</p>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="sm" onClick={() => void testTool(tool)}>
                                <Play size={13} />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => void removeTool(tool)}>
                                <Trash2 size={13} />
                              </Button>
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {tool.operation} · {tool.description || "No description"}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No tools exposed.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-3 text-sm font-medium text-slate-300">Final contract preview</h3>
                  <pre className="max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                    {JSON.stringify(contract, null, 2)}
                  </pre>
                </div>
                {testOutput && (
                  <pre className="max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                    {testOutput}
                  </pre>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Select an agent profile to configure its tools and credentials.</p>
          )}
        </section>
      </div>
    </div>
  );
}
