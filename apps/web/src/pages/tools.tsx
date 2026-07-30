import { useEffect, useState, type FormEvent } from "react";
import { Cable, Power, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/dialog";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function ToolsPage({ request }: { request: Request }) {
  const [providers, setProviders] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<RecordItem | null>(null);
  const [showRotate, setShowRotate] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("All");
  const [usage, setUsage] = useState<RecordItem | null>(null);
  const load = () => request("/api/providers").then(setProviders);
  useEffect(() => {
    void load();
  }, []);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const command = String(form.get("command") || "");
      const provider = await request("/api/providers", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          kind: form.get("kind"),
          endpoint: form.get("endpoint"),
          configuration: {
            timeout: Number(form.get("timeout")),
            transport: form.get("transport"),
            startup: form.get("startup"),
            environment: form.get("environment") ? JSON.parse(String(form.get("environment"))) : {},
            command: command ? JSON.parse(command) : undefined,
            schemaUrl: form.get("schemaUrl"),
            schema: form.get("schema") ? JSON.parse(String(form.get("schema"))) : undefined,
            headers: form.get("headers") ? JSON.parse(String(form.get("headers"))) : {},
            auth: { type: form.get("authType"), header: form.get("authHeader"), prefix: form.get("authPrefix") },
          },
          schema: {},
          credentialName: form.get("credentialName") || undefined,
          credentialSecret: form.get("credentialSecret") || undefined,
        }),
      });
      setSelected(provider);
      setShowCreate(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider creation failed");
    }
  };
  const refresh = async (provider: RecordItem, path = "refresh") => {
    setError("");
    try {
      const result = await request(`/api/providers/${provider.id}/${path}`, { method: "POST" });
      setSelected(result);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider request failed");
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await request(`/api/providers/${deleting.id}`, { method: "DELETE" });
      if (selected?.id === deleting.id) setSelected(null);
      setDeleting(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider deletion failed");
      setDeleting(null);
    }
  };
  const schema = selected?.schema?.current ?? selected?.schema ?? {};
  const filtered = providers.filter(
    (provider) =>
      filter === "All" ||
      filter === provider.kind ||
      (filter === "Available" && provider.status === "Available" && !provider.disabled) ||
      (filter === "Changed" && provider.schema?.changed) ||
      (filter === "Unavailable" && (provider.status === "Unavailable" || provider.disabled)),
  );
  const select = async (provider: RecordItem) => {
    setSelected(provider);
    setUsage(await request(`/api/providers/${provider.id}/usage`));
  };
  const toggle = async () => {
    if (!selected) return;
    setSelected(
      await request(`/api/providers/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled: !selected.disabled }),
      }),
    );
    await load();
  };
  const rotateCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      const provider = await request(`/api/providers/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          credentialName: form.get("credentialName"),
          credentialSecret: form.get("credentialSecret"),
        }),
      });
      setSelected(provider);
      setShowRotate(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Credential rotation failed");
    }
  };
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">All Tools</h1>
          <p className="mt-1 text-sm text-slate-400">Centralized MCP and OpenAPI providers, schemas, and health.</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>Add provider</Button>
      </div>
      {error && (
        <div className="mb-5 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">{error}</div>
      )}
      {showCreate && (
        <form className="mb-6 grid gap-3 rounded-xl border bg-slate-900/60 p-5 md:grid-cols-2" onSubmit={create}>
          <input required name="name" placeholder="Display name" />
          <select name="kind">
            <option>OpenAPI</option>
            <option>MCP</option>
          </select>
          <input name="endpoint" placeholder="Base URL or MCP HTTP endpoint (not needed for command)" />
          <input name="schemaUrl" placeholder="OpenAPI schema URL (defaults to endpoint)" />
          <textarea name="schema" placeholder="Inline OpenAPI JSON (optional)" />
          <select name="transport">
            <option value="http">HTTP transport</option>
            <option value="command">MCP command/stdio</option>
          </select>
          <input name="command" placeholder='Command array, e.g. ["npx","-y","server"]' />
          <select name="startup">
            <option value="on-demand">Start on demand</option>
            <option value="eager">Start when saved</option>
          </select>
          <textarea name="environment" placeholder='Command environment JSON, e.g. {"API_URL":"..."}' />
          <input name="timeout" type="number" defaultValue="10000" />
          <input name="credentialName" placeholder="Credential reference" />
          <select name="authType">
            <option value="bearer">Bearer token</option>
            <option value="header">Custom header</option>
            <option value="basic">Basic token</option>
          </select>
          <input name="authHeader" placeholder="Custom header name" />
          <input name="authPrefix" placeholder="Custom auth prefix" />
          <textarea name="headers" placeholder='Headers JSON, e.g. {"X-Client":"subpolar"}' />
          <input name="credentialSecret" type="password" placeholder="Secret (stored encrypted)" />
          <Button className="md:col-span-2">Save provider</Button>
        </form>
      )}
      <div className="grid gap-5 lg:grid-cols-[19rem_1fr]">
        <aside className="space-y-2">
          <div className="flex flex-wrap gap-1 pb-2">
            {["All", "MCP", "OpenAPI", "Available", "Changed", "Unavailable"].map((item) => (
              <Button
                key={item}
                size="sm"
                variant={filter === item ? "default" : "outline"}
                onClick={() => setFilter(item)}
              >
                {item}
              </Button>
            ))}
          </div>
          {filtered.map((provider) => (
            <button
              key={provider.id}
              onClick={() => void select(provider)}
              className={`w-full rounded-lg border p-4 text-left ${selected?.id === provider.id ? "border-cyan-500 bg-cyan-500/10" : "bg-slate-900/60 hover:bg-slate-900"}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{provider.name}</span>
                <span
                  className={provider.status === "Available" ? "text-xs text-emerald-400" : "text-xs text-amber-400"}
                >
                  {provider.disabled ? "Disabled" : provider.status}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {provider.kind} ·{" "}
                {Array.isArray(provider.schema?.current?.operations) ? provider.schema.current.operations.length : 0}{" "}
                operations
              </p>
            </button>
          ))}
        </aside>
        <section className="min-w-0 rounded-xl border bg-slate-900/60 p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Cable size={18} className="text-cyan-400" />
                    {selected.name}
                  </h2>
                  <p className="mt-1 break-all text-sm text-slate-400">{selected.endpoint}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void refresh(selected, "test")}>
                    <RefreshCw size={14} className="mr-1" />
                    Test
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void refresh(selected)}>
                    <RefreshCw size={14} className="mr-1" />
                    Rediscover
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void toggle()}>
                    <Power size={14} className="mr-1" />
                    {selected.disabled ? "Enable" : "Disable"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleting(selected)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              <div className="mt-5 grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="text-sm font-medium">Provider status</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Health</dt>
                      <dd>{selected.status}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Last connection</dt>
                      <dd>{selected.lastConnected || "Never"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-slate-500">Schema changed</dt>
                      <dd>{selected.schema?.changed ? "Yes" : "No"}</dd>
                    </div>
                  </dl>
                  <h3 className="mt-6 text-sm font-medium">Operations</h3>
                  <div className="mt-3 space-y-2">
                    {(schema.operations || []).map((operation: RecordItem) => (
                      <div
                        key={operation.operationId || operation.name}
                        className="rounded border bg-slate-950/60 p-3 text-sm"
                      >
                        <p className="font-medium text-cyan-300">{operation.operationId || operation.name}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {operation.method || "MCP"} {operation.path || operation.description || ""}
                        </p>
                      </div>
                    ))}
                    {!(schema.operations || []).length && (
                      <p className="text-sm text-slate-500">No discovered schema. Run test or rediscover.</p>
                    )}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-medium">Connection configuration</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Transport</dt>
                      <dd>{selected.configuration?.transport || "http"}</dd>
                    </div>
                    {selected.configuration?.transport === "command" && (
                      <>
                        <div className="flex justify-between gap-3">
                          <dt className="text-slate-500">Startup</dt>
                          <dd>{selected.configuration?.startup || "on-demand"}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-slate-500">Environment variables</dt>
                          <dd>{selected.configuration?.environment?.join(", ") || "None"}</dd>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Headers</dt>
                      <dd>{selected.configuration?.headers?.join(", ") || "None"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Authentication</dt>
                      <dd>{selected.configuration?.auth?.type || "Bearer token"}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Credential</dt>
                      <dd>
                        {selected.credential ? `${selected.credential.name} (${selected.credential.masked})` : "None"}
                      </dd>
                    </div>
                  </dl>
                  <Button className="mt-4" size="sm" variant="outline" onClick={() => setShowRotate(!showRotate)}>
                    Rotate credential
                  </Button>
                  {showRotate && (
                    <form className="mt-3 grid gap-2 rounded border bg-slate-950/60 p-3" onSubmit={rotateCredential}>
                      <input
                        required
                        name="credentialName"
                        defaultValue={selected.credential?.name ?? ""}
                        placeholder="Credential reference"
                      />
                      <input
                        required
                        name="credentialSecret"
                        type="password"
                        placeholder="New secret (stored encrypted)"
                      />
                      <Button size="sm">Save rotated credential</Button>
                    </form>
                  )}
                  <h3 className="text-sm font-medium">Current schema</h3>
                  <pre className="mt-3 max-h-[36rem] overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                    {JSON.stringify(selected.schema?.current ?? selected.schema ?? {}, null, 2)}
                  </pre>
                  {selected.schema?.previous && (
                    <>
                      <h3 className="mt-4 text-sm font-medium">Schema changes</h3>
                      <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                        {JSON.stringify(
                          {
                            previous: selected.schema.previous?.operations?.map(
                              (item: RecordItem) => item.operationId || item.name,
                            ),
                            current: schema.operations?.map((item: RecordItem) => item.operationId || item.name),
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </>
                  )}
                  <h3 className="mt-4 text-sm font-medium">Affected profiles and roles</h3>
                  <p className="mt-2 text-xs text-slate-400">
                    Agents: {usage?.agents?.map((item: RecordItem) => item.agent).join(", ") || "None"}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Roles: {usage?.roles?.map((item: RecordItem) => item.name).join(", ") || "None"}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Select a provider to inspect its schema and health.</p>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete provider?"
        description="This permanently deletes its centrally stored credential and cannot be undone."
        onConfirm={() => void remove()}
      />
    </div>
  );
}
