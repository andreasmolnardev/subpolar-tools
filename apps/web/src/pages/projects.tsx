import { useEffect, useState, type FormEvent } from "react";
import { FolderGit2, Play, Plus, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function ProjectsPage({ request, initialId }: { request: Request; initialId?: string }) {
  const [projects, setProjects] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [roles, setRoles] = useState<RecordItem[]>([]);
  const [roleTools, setRoleTools] = useState<RecordItem[]>([]);
  const [providers, setProviders] = useState<RecordItem[]>([]);
  const [sandboxSecrets, setSandboxSecrets] = useState<RecordItem[]>([]);
  const [repositories, setRepositories] = useState<RecordItem[]>([]);
  const [workspaces, setWorkspaces] = useState<RecordItem[]>([]);
  const [showProject, setShowProject] = useState(false);
  const [showRole, setShowRole] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [showRoleTool, setShowRoleTool] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [rotatingSecret, setRotatingSecret] = useState<RecordItem | null>(null);
  const [editingRole, setEditingRole] = useState<RecordItem | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const [deletingRole, setDeletingRole] = useState<RecordItem | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [inspection, setInspection] = useState<RecordItem | null>(null);
  const [workspaceOutput, setWorkspaceOutput] = useState<{ title: string; content: string } | null>(null);
  const [gitTarget, setGitTarget] = useState<RecordItem | null>(null);
  const [prTarget, setPrTarget] = useState<RecordItem | null>(null);
  const [workspaceSecret, setWorkspaceSecret] = useState("");
  const [error, setError] = useState("");
  const [releasing, setReleasing] = useState<RecordItem | null>(null);
  const load = async () => {
    const [nextProjects, nextProviders] = await Promise.all([request("/api/projects"), request("/api/providers")]);
    setProjects(nextProjects);
    setProviders(nextProviders);
  };
  const select = async (project: RecordItem) => {
    setSelected(project);
    const [nextRoles, nextWorkspaces, nextSecrets] = await Promise.all([
      request(`/api/projects/${project.id}/roles`),
      request(`/api/projects/${project.id}/workspaces`),
      request(`/api/projects/${project.id}/sandbox-secrets`),
    ]);
    setRoles(nextRoles);
    setWorkspaces(nextWorkspaces);
    setSandboxSecrets(nextSecrets);
    setRoleTools(
      (await Promise.all(nextRoles.map((role: RecordItem) => request(`/api/roles/${role.id}/tools`)))).flat(),
    );
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const project = projects.find((item) => item.id === initialId);
    if (project && selected?.id !== project.id) void select(project);
  }, [projects, initialId]);
  const submitProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const project = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description"),
        repository: form.get("repository"),
        gitProvider: form.get("gitProvider"),
        defaultBranch: form.get("defaultBranch"),
        createDefaultDeveloperRole: true,
        sandboxDefaults: {
          image: form.get("image"),
          cpu: form.get("cpu"),
          memory: form.get("memory"),
          timeout: Number(form.get("timeout")),
          network: form.get("network") === "on",
          isolatedHome: form.get("isolatedHome") === "on",
          homeSize: form.get("homeSize"),
          environment: JSON.parse(String(form.get("environment") || "{}")),
          caches: JSON.parse(String(form.get("caches") || "{}")),
          ...(form.get("gitAuthorName") || form.get("gitAuthorEmail")
            ? { gitIdentity: { name: form.get("gitAuthorName"), email: form.get("gitAuthorEmail") } }
            : {}),
        },
      }),
    });
    const baseUrl = String(form.get("baseUrl") || "");
    const token = String(form.get("token") || "");
    if (["Gitea", "GitHub", "GitLab"].includes(String(form.get("gitProvider"))) && baseUrl && token) {
      await request(`/api/projects/${project.id}/git-credential`, {
        method: "POST",
        body: JSON.stringify({ name: `${form.get("gitProvider")} project credential`, baseUrl, token }),
      });
    }
    setShowProject(false);
    await load();
    await select(project);
  };
  const submitRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await request(editingRole ? `/api/roles/${editingRole.id}` : `/api/projects/${selected.id}/roles`, {
      method: editingRole ? "PATCH" : "POST",
      body: JSON.stringify({
        name: form.get("name"),
        maxWorkspaces: Number(form.get("maxWorkspaces")),
        capabilities: String(form.get("capabilities"))
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        toolIds: form.getAll("toolIds").map(String),
        sandboxPolicy: {
          image: form.get("image"),
          cpu: form.get("cpu"),
          memory: form.get("memory"),
          timeout: Number(form.get("timeout")),
          network: form.get("network") === "on",
          isolatedHome: form.get("isolatedHome") === "on",
          homeSize: form.get("homeSize"),
          environment: JSON.parse(String(form.get("environment") || "{}")),
          caches: JSON.parse(String(form.get("caches") || "{}")),
          ...(form.get("gitAuthorName") || form.get("gitAuthorEmail")
            ? { gitIdentity: { name: form.get("gitAuthorName"), email: form.get("gitAuthorEmail") } }
            : {}),
          secretMounts: form.getAll("secretId").map((secretId) => ({
            secretId,
            mountPath: `/run/secrets/${sandboxSecrets.find((secret) => secret.id === secretId)?.name}`,
          })),
        },
      }),
    });
    setShowRole(false);
    setEditingRole(null);
    await select(selected);
  };
  const saveProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const project = await request(`/api/projects/${selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description"),
        repository: form.get("repository"),
        defaultBranch: form.get("defaultBranch"),
        gitProvider: form.get("gitProvider"),
        sandboxDefaults: {
          ...(selected.sandboxDefaults || {}),
          image: form.get("image"),
          cpu: form.get("cpu"),
          memory: form.get("memory"),
          timeout: Number(form.get("timeout")),
          network: form.get("network") === "on",
          isolatedHome: form.get("isolatedHome") === "on",
          homeSize: form.get("homeSize"),
          environment: JSON.parse(String(form.get("environment") || "{}")),
          caches: JSON.parse(String(form.get("caches") || "{}")),
        },
      }),
    });
    setEditingProject(false);
    await load();
    await select(project);
  };
  const submitWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await request(`/api/projects/${selected.id}/workspaces`, {
        method: "POST",
        body: JSON.stringify({ roleId: form.get("roleId"), label: form.get("label"), branch: form.get("branch") }),
      });
      setShowWorkspace(false);
      await select(selected);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Workspace creation failed");
    }
  };
  const submitGit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await request(`/api/projects/${selected.id}/git-credential`, {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), baseUrl: form.get("baseUrl"), token: form.get("token") }),
    });
    setShowGit(false);
    await select(selected);
  };
  const browseRepositories = async (formElement: HTMLFormElement) => {
    const form = new FormData(formElement);
    setRepositories(
      await request("/api/git/repositories", {
        method: "POST",
        body: JSON.stringify({
          provider: form.get("gitProvider"),
          baseUrl: form.get("baseUrl"),
          token: form.get("token"),
        }),
      }),
    );
  };
  const submitRoleTool = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const roleId = String(form.get("roleId"));
    await request(`/api/roles/${roleId}/tools`, {
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
    setShowRoleTool(false);
    if (selected) await select(selected);
  };
  const submitSecret = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await request(`/api/projects/${selected.id}/sandbox-secrets`, {
      method: "POST",
      body: JSON.stringify({ name: form.get("name"), value: form.get("value") }),
    });
    setShowSecret(false);
    await select(selected);
  };
  const lifecycle = async (workspace: RecordItem, action: "start" | "stop") => {
    await request(`/api/workspaces/${workspace.id}/${action}`, { method: "POST" });
    if (selected) await select(selected);
  };
  const inspect = async (workspace: RecordItem) =>
    setInspection(await request(`/api/workspaces/${workspace.id}/inspect`));
  const workspaceText = async (workspace: RecordItem, kind: "diff" | "logs") => {
    const result = await request(`/api/workspaces/${workspace.id}/${kind}`);
    setWorkspaceOutput({ title: `${workspace.label} ${kind}`, content: result[kind] || "No output." });
  };
  const gitOperation = async (workspace: RecordItem, operation: string, message?: string) => {
    try {
      const result = await request(`/api/workspaces/${workspace.id}/git/${operation}`, {
        method: "POST",
        body: message ? JSON.stringify({ message }) : undefined,
      });
      setWorkspaceOutput({
        title: `${workspace.label}: git ${operation}`,
        content: result.stdout || result.stderr || "Completed.",
      });
      if (selected) await select(selected);
    } catch (reason) {
      setWorkspaceOutput({
        title: `${workspace.label}: git ${operation}`,
        content: reason instanceof Error ? reason.message : "Git operation failed",
      });
    }
  };
  const release = async (workspace: RecordItem) => {
    if (!selected) return;
    await request(`/api/workspaces/${workspace.id}/release`, { method: "POST" });
    await select(selected);
    await load();
  };
  const createWorkspaceCredential = async (role: RecordItem) => {
    const result = await request(`/api/roles/${role.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({ name: `${role.name} workspace access` }),
    });
    setWorkspaceSecret(result.secret);
  };
  const focused = Boolean(initialId && initialId !== "create");
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-slate-400">
            Repositories, roles, worktrees, and isolated sandbox environments.
          </p>
        </div>
        <Button onClick={() => setShowProject(!showProject)}>
          <Plus size={16} className="mr-2" />
          Create project
        </Button>
      </div>
      <Dialog open={showProject} onOpenChange={setShowProject}>
        <DialogContent className="max-w-4xl">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription className="mt-1 text-sm text-slate-400">
            Configure a repository-backed project and its isolated sandbox defaults.
          </DialogDescription>
        <form className="mt-5 grid gap-3 md:grid-cols-2" onSubmit={submitProject}>
          <input required name="name" placeholder="Project name" />
          <input name="description" placeholder="Description" />
          <select name="gitProvider">
            <option>Gitea</option>
            <option>GitHub</option>
            <option>GitLab</option>
            <option>Generic</option>
            <option>Local</option>
          </select>
          <input name="repository" placeholder="Repository URL" />
          <input name="defaultBranch" defaultValue="main" />
          <input name="gitAuthorName" placeholder="Git author name" />
          <input name="gitAuthorEmail" type="email" placeholder="Git author email" />
          <input name="baseUrl" type="url" placeholder="Provider URL (for repository browser)" />
          <input name="token" type="password" placeholder="Temporary provider token" />
          <Button
            type="button"
            variant="outline"
            onClick={(event) => void browseRepositories(event.currentTarget.form!)}
          >
            Browse repositories
          </Button>
          <select
            defaultValue=""
            onChange={(event) => {
              const repository = repositories.find((item) => item.url === event.target.value);
              const form = event.currentTarget.form;
              if (repository && form) {
                (form.elements.namedItem("repository") as HTMLInputElement).value = repository.url;
                (form.elements.namedItem("defaultBranch") as HTMLInputElement).value = repository.defaultBranch;
              }
            }}
          >
            <option value="">Select discovered repository</option>
            {repositories.map((repository) => (
              <option key={repository.url} value={repository.url}>
                {repository.name}
              </option>
            ))}
          </select>
          <input name="image" defaultValue="alpine:3.21" placeholder="Sandbox image" />
          <input name="cpu" defaultValue="1" placeholder="CPU limit" />
          <input name="memory" defaultValue="1g" placeholder="Memory limit" />
          <input name="timeout" type="number" defaultValue="600" placeholder="Command timeout seconds" />
          <input name="homeSize" defaultValue="64m" placeholder="Isolated home size" />
          <textarea
            name="environment"
            defaultValue="{}"
            placeholder='Environment JSON, e.g. {"NODE_ENV":"development"}'
          />
          <textarea name="caches" defaultValue='{"npm":"/root/.npm"}' placeholder="Shared package caches JSON" />
          <label className="flex items-center gap-2 text-sm">
            <input name="network" type="checkbox" className="h-4 w-4" />
            Allow sandbox network access
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input name="isolatedHome" type="checkbox" defaultChecked className="h-4 w-4" />
            Isolated temporary home directory
          </label>
          <p className="text-sm text-slate-400">
            A default Developer role is created with safe Git and workspace capabilities.
          </p>
          <Button className="md:col-span-2">Create project</Button>
        </form>
        </DialogContent>
      </Dialog>
      <div className={`grid gap-5 ${focused ? "lg:grid-cols-1" : "lg:grid-cols-[19rem_1fr]"}`}>
        {!focused && <aside className="space-y-2">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => void select(project)}
              className={`w-full rounded-lg border p-4 text-left ${selected?.id === project.id ? "border-blue-500 bg-blue-500/10" : "bg-slate-950/70 hover:bg-slate-950"}`}
            >
              <p className="font-medium">{project.name}</p>
              <p className="mt-1 truncate text-sm text-slate-500">{project.repository || "Local-only"}</p>
            </button>
          ))}
        </aside>}
          <section className="rounded-xl border bg-slate-950/70 p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <FolderGit2 size={18} className="text-blue-400" />
                    {selected.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {selected.gitProvider} · {selected.defaultBranch}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowGit(!showGit)}>
                    Rotate Git credential
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditingProject(!editingProject)}>
                    Settings
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingRole(null);
                      setShowRole(!showRole);
                    }}
                  >
                    Add role
                  </Button>
                  <Button size="sm" onClick={() => setShowWorkspace(!showWorkspace)}>
                    Create workspace
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setDeletingProject(true)}>
                    Delete
                  </Button>
                </div>
              </div>
              {editingProject && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-2" onSubmit={saveProject}>
                  <input required name="name" defaultValue={selected.name} />
                  <input name="description" defaultValue={selected.description} />
                  <input name="repository" defaultValue={selected.repository} />
                  <input name="defaultBranch" defaultValue={selected.defaultBranch} />
                  <select name="gitProvider" defaultValue={selected.gitProvider}>
                    <option>Gitea</option>
                    <option>GitHub</option>
                    <option>GitLab</option>
                    <option>Generic</option>
                    <option>Local</option>
                  </select>
                  <input
                    name="image"
                    defaultValue={selected.sandboxDefaults?.image ?? "alpine:3.21"}
                    placeholder="Sandbox image"
                  />
                  <input name="cpu" defaultValue={selected.sandboxDefaults?.cpu ?? "1"} placeholder="CPU limit" />
                  <input
                    name="memory"
                    defaultValue={selected.sandboxDefaults?.memory ?? "1g"}
                    placeholder="Memory limit"
                  />
                  <input
                    name="timeout"
                    type="number"
                    defaultValue={selected.sandboxDefaults?.timeout ?? 600}
                    placeholder="Command timeout seconds"
                  />
                  <input
                    name="homeSize"
                    defaultValue={selected.sandboxDefaults?.homeSize ?? "64m"}
                    placeholder="Isolated home size"
                  />
                  <textarea
                    name="environment"
                    defaultValue={JSON.stringify(selected.sandboxDefaults?.environment ?? {})}
                    placeholder="Environment JSON"
                  />
                  <textarea
                    name="caches"
                    defaultValue={JSON.stringify(selected.sandboxDefaults?.caches ?? {})}
                    placeholder="Shared package caches JSON"
                  />
                  <input
                    name="gitAuthorName"
                    defaultValue={selected.sandboxDefaults?.gitIdentity?.name}
                    placeholder="Git author name"
                  />
                  <input
                    name="gitAuthorEmail"
                    type="email"
                    defaultValue={selected.sandboxDefaults?.gitIdentity?.email}
                    placeholder="Git author email"
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      name="network"
                      type="checkbox"
                      defaultChecked={selected.sandboxDefaults?.network}
                      className="h-4 w-4"
                    />
                    Allow sandbox network access
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      name="isolatedHome"
                      type="checkbox"
                      defaultChecked={selected.sandboxDefaults?.isolatedHome !== false}
                      className="h-4 w-4"
                    />
                    Isolated temporary home directory
                  </label>
                  <Button className="md:col-span-2">Save settings</Button>
                </form>
              )}
              {showGit && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-3" onSubmit={submitGit}>
                  <input required name="name" placeholder="Credential name" />
                  <input
                    required
                    name="baseUrl"
                    type="url"
                    defaultValue={selected.gitProvider === "GitHub" ? "https://api.github.com" : undefined}
                    placeholder="Provider API URL, e.g. https://gitea.example"
                  />
                  <input required name="token" type="password" placeholder="Provider access token" />
                  <p className="text-xs text-slate-500 md:col-span-3">
                    The replacement token is encrypted centrally. The prior credential is deleted after rotation.
                  </p>
                  <Button className="md:col-span-3">Save Git integration</Button>
                </form>
              )}
              {showRole && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-3" onSubmit={submitRole}>
                  <input required name="name" defaultValue={editingRole?.name} placeholder="Role name" />
                  <input name="maxWorkspaces" type="number" min="1" defaultValue={editingRole?.maxWorkspaces ?? "1"} />
                  <input
                    name="capabilities"
                    defaultValue={(
                      editingRole?.capabilities || [
                        "filesystem.read",
                        "filesystem.write",
                        "filesystem.search",
                        "shell.execute",
                        "git.status",
                        "git.diff",
                        "git.log",
                      ]
                    ).join(", ")}
                  />
                  <input name="image" defaultValue="alpine:3.21" placeholder="Sandbox image" />
                  <input name="cpu" defaultValue="1" placeholder="CPU limit" />
                  <input name="memory" defaultValue="1g" placeholder="Memory limit" />
                  <input name="timeout" type="number" defaultValue="600" placeholder="Command timeout seconds" />
                  <input
                    name="homeSize"
                    defaultValue={editingRole?.sandboxPolicy?.homeSize ?? "64m"}
                    placeholder="Isolated home size"
                  />
                  <textarea
                    name="environment"
                    defaultValue={JSON.stringify(editingRole?.sandboxPolicy?.environment ?? {})}
                    placeholder="Environment JSON"
                  />
                  <textarea
                    name="caches"
                    defaultValue={JSON.stringify(editingRole?.sandboxPolicy?.caches ?? {})}
                    placeholder="Shared package caches JSON"
                  />
                  <label className="flex items-center gap-2 text-sm md:col-span-3">
                    <input name="network" type="checkbox" className="h-4 w-4" />
                    Allow network access for this role
                  </label>
                  <label className="flex items-center gap-2 text-sm md:col-span-3">
                    <input
                      name="isolatedHome"
                      type="checkbox"
                      defaultChecked={editingRole?.sandboxPolicy?.isolatedHome !== false}
                      className="h-4 w-4"
                    />
                    Use an isolated temporary home directory
                  </label>
                  <fieldset className="md:col-span-3">
                    <legend className="text-sm font-medium">Mounted sandbox secrets</legend>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {sandboxSecrets.map((secret) => (
                        <label className="flex items-center gap-2 text-sm" key={secret.id}>
                          <input
                            name="secretId"
                            type="checkbox"
                            value={secret.id}
                            defaultChecked={editingRole?.sandboxPolicy?.secretMounts?.some(
                              (mount: RecordItem) => mount.secretId === secret.id,
                            )}
                          />
                          {secret.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="md:col-span-3">
                    <legend className="text-sm font-medium">External providers available to this role</legend>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {providers
                        .filter((provider) => !provider.disabled)
                        .map((provider) => (
                          <label className="flex items-center gap-2 text-sm" key={provider.id}>
                            <input
                              name="toolIds"
                              type="checkbox"
                              value={provider.id}
                              defaultChecked={Boolean(editingRole?.toolIds?.includes(provider.id))}
                            />
                            {provider.name}
                          </label>
                        ))}
                    </div>
                  </fieldset>
                  <Button className="md:col-span-3">{editingRole ? "Update role" : "Save role"}</Button>
                </form>
              )}
              {showWorkspace && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-3" onSubmit={submitWorkspace}>
                  <select required name="roleId">
                    <option value="">Project role</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                  <input required name="label" placeholder="Workspace label" />
                  <input required name="branch" placeholder="Feature branch" />
                  {error && <p className="text-sm text-rose-400 md:col-span-3">{error}</p>}
                  <Button className="md:col-span-3">Provision worktree and sandbox</Button>
                </form>
              )}
              {workspaceSecret && (
                <div className="mt-5 rounded-lg border border-blue-700 bg-slate-950 p-4">
                  <p className="text-sm font-medium">
                    Store this workspace credential now. It will not be shown again.
                  </p>
                  <code className="mt-2 block overflow-auto text-sm text-blue-300">{workspaceSecret}</code>
                  <Button className="mt-3" variant="outline" size="sm" onClick={() => setWorkspaceSecret("")}>
                    I stored it
                  </Button>
                </div>
              )}
              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <div>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-medium">Roles</h3>
                    <Button variant="outline" size="sm" onClick={() => setShowRoleTool(!showRoleTool)}>
                      Add role adapter
                    </Button>
                  </div>
                  {showRoleTool && (
                    <form className="mb-3 grid gap-2 rounded-lg border p-3" onSubmit={submitRoleTool}>
                      <select required name="roleId">
                        <option value="">Role</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                      <select required name="providerId">
                        <option value="">Selected provider</option>
                        {providers
                          .filter((provider) => !provider.disabled)
                          .map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                      </select>
                      <input required name="operation" placeholder="Provider operation" />
                      <input required name="exposedName" placeholder="Role tool name" />
                      <input name="description" placeholder="Description" />
                      <textarea name="inputSchema" defaultValue="{}" placeholder="Input schema JSON" />
                      <textarea name="inputMap" defaultValue="{}" placeholder="Input map JSON" />
                      <textarea name="fixedArgs" defaultValue="{}" placeholder="Fixed arguments JSON" />
                      <textarea name="outputMap" defaultValue="{}" placeholder="Output map JSON" />
                      <Button>Save adapter</Button>
                    </form>
                  )}
                  {roles.map((role) => (
                    <div key={role.id} className="mb-2 rounded-lg border bg-slate-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{role.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">max {role.maxWorkspaces}</span>
                          <Button variant="outline" size="sm" onClick={() => void createWorkspaceCredential(role)}>
                            Credential
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditingRole(role);
                              setShowRole(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => setDeletingRole(role)}>
                            Delete
                          </Button>
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">{(role.capabilities || []).join(", ")}</p>
                      <p className="mt-1 text-xs text-blue-400">
                        Providers:{" "}
                        {(role.toolIds || [])
                          .map((id: string) => providers.find((provider) => provider.id === id)?.name ?? id)
                          .join(", ") || "None"}
                      </p>
                      <div className="mt-2 space-y-1">
                        {roleTools
                          .filter((tool) => tool.roleId === role.id)
                          .map((tool) => (
                            <div key={tool.id} className="flex items-center justify-between text-xs text-slate-400">
                              <span>
                                {tool.exposedName} → {tool.operation}
                              </span>
                              <button
                                className="text-rose-400"
                                onClick={() =>
                                  selected &&
                                  void request(`/api/roles/${role.id}/tools/${tool.id}`, { method: "DELETE" }).then(
                                    () => select(selected),
                                  )
                                }
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                  <div className="mt-5 border-t pt-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">Sandbox secrets</h3>
                      <Button variant="outline" size="sm" onClick={() => setShowSecret(!showSecret)}>
                        Add secret
                      </Button>
                    </div>
                    {showSecret && (
                      <form className="mt-3 grid gap-2" onSubmit={submitSecret}>
                        <input required name="name" placeholder="Secret name" />
                        <input required name="value" type="password" placeholder="Secret value" />
                        <Button>Store encrypted secret</Button>
                      </form>
                    )}
                    {rotatingSecret && (
                      <form
                        className="mt-3 flex gap-2"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          if (!selected) return;
                          const value = new FormData(event.currentTarget).get("value");
                          await request(`/api/projects/${selected.id}/sandbox-secrets/${rotatingSecret.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({ value }),
                          });
                          setRotatingSecret(null);
                          await select(selected);
                        }}
                      >
                        <input
                          required
                          name="value"
                          type="password"
                          placeholder={`Replacement value for ${rotatingSecret.name}`}
                        />
                        <Button>Rotate</Button>
                        <Button type="button" variant="outline" onClick={() => setRotatingSecret(null)}>
                          Cancel
                        </Button>
                      </form>
                    )}
                    <div className="mt-3 space-y-2">
                      {sandboxSecrets.map((secret) => (
                        <div className="flex items-center justify-between rounded border p-2 text-sm" key={secret.id}>
                          <span>
                            {secret.name} <span className="text-slate-500">Configured</span>
                          </span>
                          <div className="flex gap-2">
                            <Button variant="outline" size="sm" onClick={() => setRotatingSecret(secret)}>
                              Rotate
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() =>
                                selected &&
                                void request(`/api/projects/${selected.id}/sandbox-secrets/${secret.id}`, {
                                  method: "DELETE",
                                }).then(() => select(selected))
                              }
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div>
                  <h3 className="mb-3 text-sm font-medium">Workspaces</h3>
                  {workspaces.map((workspace) => (
                    <div key={workspace.id} className="mb-2 rounded-lg border bg-slate-950/60 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{workspace.label}</p>
                          <p className="text-xs text-slate-500">
                            {workspace.branch} · {workspace.handle} · {workspace.sandboxState}
                          </p>
                          <p className="text-xs text-slate-500">
                            Last activity: {new Date(workspace.lastActivity).toLocaleString()}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void navigator.clipboard.writeText(workspace.handle)}
                          >
                            Copy handle
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void inspect(workspace)}>
                            Inspect
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void workspaceText(workspace, "diff")}>
                            Diff
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void workspaceText(workspace, "logs")}>
                            Logs
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void gitOperation(workspace, "fetch")}>
                            Fetch
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void gitOperation(workspace, "pull")}>
                            Pull
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => void gitOperation(workspace, "push")}>
                            Push
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => setGitTarget(workspace)}>
                            Commit
                          </Button>
                          {selected.gitProvider !== "Generic" && selected.gitProvider !== "Local" && (
                            <Button variant="outline" size="sm" onClick={() => setPrTarget(workspace)}>
                              Pull request
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void lifecycle(workspace, workspace.sandboxState === "Running" ? "stop" : "start")
                            }
                          >
                            {workspace.sandboxState === "Running" ? (
                              <>
                                <Square size={13} className="mr-1" />
                                Stop
                              </>
                            ) : (
                              <>
                                <Play size={13} className="mr-1" />
                                Start
                              </>
                            )}
                          </Button>
                          <Button variant="destructive" size="sm" onClick={() => setReleasing(workspace)}>
                            Release
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!workspaces.length && <p className="text-sm text-slate-500">No active workspaces.</p>}
                  {inspection && (
                    <div className="mt-3 rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                      <p>Worktree: {inspection.worktreePath || "Unavailable"}</p>
                      <p>
                        Sandbox: {inspection.sandboxState} · Resources: {inspection.resourceUsage}
                      </p>
                      <p>Last activity: {new Date(inspection.lastActivity).toLocaleString()}</p>
                      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">
                        {inspection.gitStatus || "Working tree clean"}
                      </pre>
                    </div>
                  )}
                  {workspaceOutput && (
                    <div className="mt-3 rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                      <p className="mb-2 font-medium">{workspaceOutput.title}</p>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{workspaceOutput.content}</pre>
                    </div>
                  )}
                  {gitTarget && (
                    <form
                      className="mt-3 flex flex-wrap gap-2 rounded-lg border p-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const message = String(new FormData(event.currentTarget).get("message"));
                        void gitOperation(gitTarget, "commit", message);
                        setGitTarget(null);
                      }}
                    >
                      <input
                        required
                        name="message"
                        maxLength={500}
                        className="min-w-64 flex-1"
                        placeholder="Commit message"
                      />
                      <Button>Commit staged changes</Button>
                      <Button type="button" variant="outline" onClick={() => setGitTarget(null)}>
                        Cancel
                      </Button>
                    </form>
                  )}
                  {prTarget && (
                    <form
                      className="mt-3 grid gap-2 rounded-lg border p-3"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        const form = new FormData(event.currentTarget);
                        try {
                          const result = await request(`/api/workspaces/${prTarget.id}/pull-requests`, {
                            method: "POST",
                            body: JSON.stringify({ title: form.get("title"), body: form.get("body") }),
                          });
                          setWorkspaceOutput({
                            title: `${result.provider} pull request created`,
                            content: `${result.url || "Created"}${result.number ? ` (#${result.number})` : ""}`,
                          });
                        } catch (reason) {
                          setWorkspaceOutput({
                            title: `${selected.gitProvider} pull request failed`,
                            content: reason instanceof Error ? reason.message : "Provider request failed",
                          });
                        }
                        setPrTarget(null);
                      }}
                    >
                      <input required name="title" maxLength={255} placeholder="Pull-request title" />
                      <textarea name="body" maxLength={10000} placeholder="Description" />
                      <div className="flex gap-2">
                        <Button>Create pull request</Button>
                        <Button type="button" variant="outline" onClick={() => setPrTarget(null)}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Select a project to manage roles and workspaces.</p>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={Boolean(releasing)}
        onOpenChange={(open) => !open && setReleasing(null)}
        title={`Release ${releasing?.label ?? "workspace"}?`}
        description="This deletes the workspace sandbox and worktree."
        onConfirm={() => {
          const workspace = releasing;
          setReleasing(null);
          if (workspace) void release(workspace);
        }}
      />
      <ConfirmDialog
        open={Boolean(deletingRole)}
        onOpenChange={(open) => !open && setDeletingRole(null)}
        title={`Delete ${deletingRole?.name ?? "role"}?`}
        description="The role must have no active workspaces."
        onConfirm={() => {
          const role = deletingRole;
          setDeletingRole(null);
          if (role && selected)
            void request(`/api/roles/${role.id}`, { method: "DELETE" }).then(() => select(selected));
        }}
      />
      <ConfirmDialog
        open={deletingProject}
        onOpenChange={setDeletingProject}
        title={`Delete ${selected?.name ?? "project"}?`}
        description="The project must have no active workspaces."
        onConfirm={() => {
          if (selected)
            void request(`/api/projects/${selected.id}`, { method: "DELETE" }).then(async () => {
              setSelected(null);
              setDeletingProject(false);
              await load();
            });
        }}
      />
    </div>
  );
}
