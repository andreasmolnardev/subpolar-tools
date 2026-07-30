import { useEffect, useState, type FormEvent } from "react";
import { FolderGit2, Play, Plus, Square } from "lucide-react";
import { Button } from "../components/ui/button";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function ProjectsPage({ request }: { request: Request }) {
  const [projects, setProjects] = useState<RecordItem[]>([]);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [roles, setRoles] = useState<RecordItem[]>([]);
  const [workspaces, setWorkspaces] = useState<RecordItem[]>([]);
  const [showProject, setShowProject] = useState(false);
  const [showRole, setShowRole] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showGit, setShowGit] = useState(false);
  const [inspection, setInspection] = useState<RecordItem | null>(null);
  const [workspaceSecret, setWorkspaceSecret] = useState("");
  const [error, setError] = useState("");
  const load = () => request("/api/projects").then(setProjects);
  const select = async (project: RecordItem) => {
    setSelected(project);
    const [nextRoles, nextWorkspaces] = await Promise.all([
      request(`/api/projects/${project.id}/roles`),
      request(`/api/projects/${project.id}/workspaces`),
    ]);
    setRoles(nextRoles);
    setWorkspaces(nextWorkspaces);
  };
  useEffect(() => {
    void load();
  }, []);
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
        },
      }),
    });
    setShowProject(false);
    await load();
    await select(project);
  };
  const submitRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    await request(`/api/projects/${selected.id}/roles`, {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        maxWorkspaces: Number(form.get("maxWorkspaces")),
        capabilities: String(form.get("capabilities"))
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        sandboxPolicy: {
          image: form.get("image"),
          cpu: form.get("cpu"),
          memory: form.get("memory"),
          timeout: Number(form.get("timeout")),
          network: form.get("network") === "on",
        },
      }),
    });
    setShowRole(false);
    await select(selected);
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
  const lifecycle = async (workspace: RecordItem, action: "start" | "stop") => {
    await request(`/api/workspaces/${workspace.id}/${action}`, { method: "POST" });
    if (selected) await select(selected);
  };
  const inspect = async (workspace: RecordItem) =>
    setInspection(await request(`/api/workspaces/${workspace.id}/inspect`));
  const release = async (workspace: RecordItem) => {
    if (!selected || !confirm(`Release workspace ${workspace.label}? This deletes its sandbox and worktree.`)) return;
    await request(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
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
      {showProject && (
        <form className="mb-6 grid gap-3 rounded-xl border bg-slate-900/60 p-5 md:grid-cols-2" onSubmit={submitProject}>
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
          <input name="image" defaultValue="alpine:3.21" placeholder="Sandbox image" />
          <input name="cpu" defaultValue="1" placeholder="CPU limit" />
          <input name="memory" defaultValue="1g" placeholder="Memory limit" />
          <input name="timeout" type="number" defaultValue="600" placeholder="Command timeout seconds" />
          <label className="flex items-center gap-2 text-sm">
            <input name="network" type="checkbox" className="h-4 w-4" />
            Allow sandbox network access
          </label>
          <p className="text-sm text-slate-400">
            A default Developer role is created with safe Git and workspace capabilities.
          </p>
          <Button className="md:col-span-2">Create project</Button>
        </form>
      )}
      <div className="grid gap-5 lg:grid-cols-[19rem_1fr]">
        <aside className="space-y-2">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => void select(project)}
              className={`w-full rounded-lg border p-4 text-left ${selected?.id === project.id ? "border-cyan-500 bg-cyan-500/10" : "bg-slate-900/60 hover:bg-slate-900"}`}
            >
              <p className="font-medium">{project.name}</p>
              <p className="mt-1 truncate text-sm text-slate-500">{project.repository || "Local-only"}</p>
            </button>
          ))}
        </aside>
        <section className="rounded-xl border bg-slate-900/60 p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <FolderGit2 size={18} className="text-cyan-400" />
                    {selected.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {selected.gitProvider} · {selected.defaultBranch}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShowGit(!showGit)}>
                    Git integration
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowRole(!showRole)}>
                    Add role
                  </Button>
                  <Button size="sm" onClick={() => setShowWorkspace(!showWorkspace)}>
                    Create workspace
                  </Button>
                </div>
              </div>
              {showGit && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-3" onSubmit={submitGit}>
                  <input required name="name" placeholder="Credential name" />
                  <input required name="baseUrl" type="url" placeholder="Provider URL, e.g. https://gitea.example" />
                  <input required name="token" type="password" placeholder="Provider access token" />
                  <p className="text-xs text-slate-500 md:col-span-3">
                    The token is encrypted centrally and is used only for pull-request creation.
                  </p>
                  <Button className="md:col-span-3">Save Git integration</Button>
                </form>
              )}
              {showRole && (
                <form className="mt-5 grid gap-3 border-t pt-5 md:grid-cols-3" onSubmit={submitRole}>
                  <input required name="name" placeholder="Role name" />
                  <input name="maxWorkspaces" type="number" min="1" defaultValue="1" />
                  <input
                    name="capabilities"
                    defaultValue="filesystem.read, filesystem.write, filesystem.search, shell.execute, git.status, git.diff, git.log"
                  />
                  <input name="image" defaultValue="alpine:3.21" placeholder="Sandbox image" />
                  <input name="cpu" defaultValue="1" placeholder="CPU limit" />
                  <input name="memory" defaultValue="1g" placeholder="Memory limit" />
                  <input name="timeout" type="number" defaultValue="600" placeholder="Command timeout seconds" />
                  <label className="flex items-center gap-2 text-sm md:col-span-3">
                    <input name="network" type="checkbox" className="h-4 w-4" />
                    Allow network access for this role
                  </label>
                  <Button className="md:col-span-3">Save role</Button>
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
                <div className="mt-5 rounded-lg border border-cyan-700 bg-slate-950 p-4">
                  <p className="text-sm font-medium">
                    Store this workspace credential now. It will not be shown again.
                  </p>
                  <code className="mt-2 block overflow-auto text-sm text-cyan-300">{workspaceSecret}</code>
                  <Button className="mt-3" variant="outline" size="sm" onClick={() => setWorkspaceSecret("")}>
                    I stored it
                  </Button>
                </div>
              )}
              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <div>
                  <h3 className="mb-3 text-sm font-medium">Roles</h3>
                  {roles.map((role) => (
                    <div key={role.id} className="mb-2 rounded-lg border bg-slate-950/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{role.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400">max {role.maxWorkspaces}</span>
                          <Button variant="outline" size="sm" onClick={() => void createWorkspaceCredential(role)}>
                            Credential
                          </Button>
                        </div>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">{(role.capabilities || []).join(", ")}</p>
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="mb-3 text-sm font-medium">Workspaces</h3>
                  {workspaces.map((workspace) => (
                    <div key={workspace.id} className="mb-2 rounded-lg border bg-slate-950/60 p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">{workspace.label}</p>
                          <p className="text-xs text-slate-500">
                            {workspace.branch} · {workspace.handle}
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
                          <Button variant="destructive" size="sm" onClick={() => void release(workspace)}>
                            Release
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {!workspaces.length && <p className="text-sm text-slate-500">No active workspaces.</p>}
                  {inspection && (
                    <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">
                      {JSON.stringify(inspection, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400">Select a project to manage roles and workspaces.</p>
          )}
        </section>
      </div>
    </div>
  );
}
