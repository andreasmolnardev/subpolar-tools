import { useEffect, useState, type FormEvent } from "react";
import { Bot, KeyRound, Play, Plus, Power, Trash2, Wrench } from "lucide-react";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/dialog";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function AgentsPage({ request }: { request: Request }) {
  const [agents, setAgents] = useState<RecordItem[]>([]);
  const [providers, setProviders] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [tools, setTools] = useState<RecordItem[]>([]);
  const [credentials, setCredentials] = useState<RecordItem[]>([]);
  const [contract, setContract] = useState<RecordItem | null>(null);
  const [secret, setSecret] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showTool, setShowTool] = useState(false);
  const [editingTool, setEditingTool] = useState<RecordItem | null>(null);
  const [editingAgent, setEditingAgent] = useState(false);
  const [testOutput, setTestOutput] = useState("");
  const [validation, setValidation] = useState<Record<string, RecordItem>>({});
  const [confirming, setConfirming] = useState<{ title: string; action: () => Promise<void> } | null>(null);
  const [testing, setTesting] = useState<RecordItem | null>(null);

  const load = async () => {
    const [nextAgents, nextProviders] = await Promise.all([request("/api/agents"), request("/api/providers")]);
    setAgents(nextAgents);
    setProviders(nextProviders);
  };
  const select = async (agent: RecordItem) => {
    setSelected(agent);
    const [nextTools, nextContract, nextCredentials] = await Promise.all([
      request(`/api/agents/${agent.id}/tools`),
      request(`/api/agents/${agent.id}/contract`),
      request(`/api/agents/${agent.id}/credentials`),
    ]);
    setTools(nextTools);
    setContract(nextContract);
    setCredentials(nextCredentials);
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
    await request(`/api/agents/${selected.id}/tools${editingTool ? `/${editingTool.id}` : ""}`, {
      method: editingTool ? "PATCH" : "POST",
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
    setEditingTool(null);
    await select(selected);
    await load();
  };
  const saveAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const updated = await request(`/api/agents/${selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: form.get("name"), description: form.get("description") }),
    });
    setEditingAgent(false);
    await load();
    await select(updated);
  };
  const createCredential = async () => {
    if (!selected) return;
    const result = await request(`/api/agents/${selected.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({ name: "Admin console" }),
    });
    setSecret(result.secret);
    await select(selected);
  };
  const revokeCredential = async (credential: RecordItem) => {
    if (!selected) return;
    setConfirming({
      title: `Revoke ${credential.name}?`,
      action: async () => {
        await request(`/api/agent-credentials/${credential.id}/revoke`, { method: "POST" });
        await select(selected);
      },
    });
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
    if (!selected) return;
    setConfirming({
      title: `Remove ${tool.exposedName}?`,
      action: async () => {
        await request(`/api/agents/${selected.id}/tools/${tool.id}`, { method: "DELETE" });
        await select(selected);
      },
    });
  };
  const testTool = async (tool: RecordItem) => {
    if (!selected) return;
    setTesting(tool);
  };
  const removeAgent = () =>
    selected &&
    setConfirming({
      title: `Delete ${selected.name}?`,
      action: async () => {
        await request(`/api/agents/${selected.id}`, { method: "DELETE" });
        setSelected(null);
        setTools([]);
        await load();
      },
    });

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
                  <Button variant="outline" size="sm" onClick={() => setEditingAgent(!editingAgent)}>
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingTool(null);
                      setShowTool(!showTool);
                    }}
                  >
                    <Wrench size={14} className="mr-2" />
                    Expose tool
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void createCredential()}>
                    <KeyRound size={14} className="mr-2" />
                    Credential
                  </Button>
                  <Button variant="destructive" size="sm" onClick={removeAgent}>
                    Delete
                  </Button>
                </div>
              </div>
              {editingAgent && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-2" onSubmit={saveAgent}>
                  <input required name="name" defaultValue={selected.name} />
                  <input name="description" defaultValue={selected.description} />
                  <Button className="md:col-span-2">Save profile</Button>
                </form>
              )}
              {showTool && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-2" onSubmit={addTool}>
                  <select required name="providerId" defaultValue={editingTool?.providerId ?? ""}>
                    <option value="">Provider</option>
                    {providers
                      .filter((provider) => !provider.disabled)
                      .map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.kind})
                        </option>
                      ))}
                  </select>
                  <input
                    required
                    name="operation"
                    defaultValue={editingTool?.operation}
                    placeholder="Underlying operation, e.g. query"
                  />
                  <input
                    required
                    name="exposedName"
                    defaultValue={editingTool?.exposedName}
                    placeholder="Exposed name, e.g. web.search"
                  />
                  <input
                    name="description"
                    defaultValue={editingTool?.description}
                    placeholder="Model-visible description"
                  />
                  <textarea
                    name="inputSchema"
                    defaultValue={JSON.stringify(editingTool?.inputSchema ?? {}, null, 2)}
                    placeholder="Exposed JSON schema"
                  />
                  <textarea
                    name="inputMap"
                    defaultValue={JSON.stringify(editingTool?.inputMap ?? {}, null, 2)}
                    placeholder='Input map, e.g. {"query":"q"}'
                  />
                  <textarea
                    name="fixedArgs"
                    defaultValue={JSON.stringify(editingTool?.fixedArgs ?? {}, null, 2)}
                    placeholder="Fixed hidden arguments"
                  />
                  <textarea
                    name="outputMap"
                    defaultValue={JSON.stringify(editingTool?.outputMap ?? {}, null, 2)}
                    placeholder="Output map"
                  />
                  <Button className="md:col-span-2">{editingTool ? "Update adapter" : "Save adapter"}</Button>
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
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  selected &&
                                  void request(`/api/agents/${selected.id}/tools/${tool.id}/validate`, {
                                    method: "POST",
                                  }).then((result) => setValidation((current) => ({ ...current, [tool.id]: result })))
                                }
                              >
                                Validate
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditingTool(tool);
                                  setShowTool(true);
                                }}
                              >
                                Edit
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => void removeTool(tool)}>
                                <Trash2 size={13} />
                              </Button>
                            </div>
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {tool.operation} · {tool.description || "No description"}
                          </p>
                          {validation[tool.id] && (
                            <p
                              className={`mt-2 text-xs ${validation[tool.id].valid ? "text-emerald-400" : "text-rose-400"}`}
                            >
                              {validation[tool.id].valid
                                ? "Schema mapping valid"
                                : validation[tool.id].errors?.join(", ")}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No tools exposed.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-3 text-sm font-medium text-slate-300">Final contract preview</h3>
                  <p className="mb-2 break-all text-xs text-slate-500">
                    MCP: {location.origin}/api/v1/mcp
                    <br />
                    OpenAPI: {location.origin}/api/v1/agents/{selected.id}/openapi.json
                  </p>
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
              <div className="mt-6 border-t pt-5">
                <h3 className="text-sm font-medium text-slate-300">MCP and OpenAPI access tokens</h3>
                <p className="mt-1 text-sm text-slate-500">
                  Each token authorizes this profile through the MCP endpoint and its generated OpenAPI contract.
                </p>
                <div className="mt-3 space-y-2">
                  {credentials.map((credential) => (
                    <div
                      key={credential.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-slate-950/60 p-3"
                    >
                      <div>
                        <p className="font-medium">{credential.name}</p>
                        <p className="text-xs text-slate-500">
                          Created {credential.created} · last used {credential.lastUsed || "Never"}
                        </p>
                      </div>
                      <Button
                        variant={credential.revoked ? "outline" : "destructive"}
                        size="sm"
                        disabled={credential.revoked}
                        onClick={() => void revokeCredential(credential)}
                      >
                        {credential.revoked ? "Revoked" : "Revoke"}
                      </Button>
                    </div>
                  ))}
                  {!credentials.length && <p className="text-sm text-slate-500">No API tokens have been generated.</p>}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Select an agent profile to configure its tools and credentials.</p>
          )}
        </section>
      </div>
      {testing && (
        <form
          className="fixed inset-0 z-40 grid place-items-center bg-slate-950/80 p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const raw = String(new FormData(event.currentTarget).get("input") || "{}");
            const result = await request(`/api/agents/${selected!.id}/tools/${testing.id}/test`, {
              method: "POST",
              body: raw,
            });
            setTestOutput(JSON.stringify(result, null, 2));
            setTesting(null);
          }}
        >
          <div className="w-full max-w-lg rounded-xl border bg-slate-900 p-5">
            <h2 className="font-semibold">Test {testing.exposedName}</h2>
            <textarea className="mt-3 w-full" name="input" defaultValue="{}" />
            <div className="mt-3 flex gap-2">
              <Button>Run test</Button>
              <Button type="button" variant="outline" onClick={() => setTesting(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </form>
      )}
      <ConfirmDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming?.title ?? "Confirm action"}
        description="This action cannot be undone."
        onConfirm={() => {
          const action = confirming?.action;
          setConfirming(null);
          if (action) void action();
        }}
      />
    </div>
  );
}
