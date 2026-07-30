import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import "@fontsource-variable/geist";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Boxes,
  Cable,
  FolderGit2,
  Plus,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { AgentsPage } from "./pages/agents";
import { ProjectsPage } from "./pages/projects";
import { SettingsPage } from "./pages/settings";
import { ToolsPage } from "./pages/tools";
import { UsersPage } from "./pages/users";
import "./web.css";

type Item = Record<string, any>;
const api = async (path: string, options: RequestInit = {}) => {
  const token = localStorage.getItem("subpolar-token") ?? sessionStorage.getItem("subpolar-token");
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Request failed");
  return res.status === 204 ? null : res.json();
};
function Header({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function Login({ onLogin }: { onLogin(user: Item): void }) {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState(() => {
    if (location.pathname === "/reset-password") return "reset";
    if (location.pathname === "/verify-email") return "verify";
    return "sign-in";
  });
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError("");
    setMessage("");
    try {
      if (mode === "forgot") {
        await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: form.get("email") }) });
        setMessage("If the account exists, a password-reset link has been sent.");
        return;
      }
      if (mode === "reset") {
        const token = new URLSearchParams(location.search).get("token");
        if (!token) throw new Error("The password-reset link is missing its token");
        await api("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token, password: form.get("password") }),
        });
        setMessage("Password reset. You can now sign in.");
        setMode("sign-in");
        return;
      }
      const result = await api("/api/auth/sign-in", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          persistent: form.get("persistent") === "on",
        }),
      });
      const storage = form.get("persistent") === "on" ? localStorage : sessionStorage;
      const otherStorage = storage === localStorage ? sessionStorage : localStorage;
      otherStorage.removeItem("subpolar-token");
      storage.setItem("subpolar-token", result.token);
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    }
  };
  useEffect(() => {
    if (mode !== "verify") return;
    const token = new URLSearchParams(location.search).get("token");
    if (!token) {
      setError("The verification link is missing its token");
      return;
    }
    void api("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setMessage("Email verified. You can now sign in."))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Verification failed"));
  }, [mode]);
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <Card className="shadow-2xl shadow-blue-950/30">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-blue-500 text-white shadow-lg shadow-blue-950/40">
                <Boxes size={22} />
              </div>
              <div>
                <CardTitle>Subpolar Tools</CardTitle>
                <CardDescription className="mt-1">Administration console</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
        {mode === "verify" ? (
          <p className="text-sm text-slate-400">Confirming your email verification link.</p>
        ) : (
          <>
            {mode !== "reset" && (
              <Label className="block space-y-2">
                Email
                <Input required name="email" type="email" placeholder="admin@example.com" />
              </Label>
            )}
            {mode !== "forgot" && (
              <Label className={mode === "reset" ? "block space-y-2" : "mt-4 block space-y-2"}>
                {mode === "reset" ? "New password" : "Password"}
                <Input required name="password" type="password" minLength={12} />
              </Label>
            )}
            {mode === "sign-in" && (
              <Label className="mt-4 flex items-center gap-2 text-sm">
                <input name="persistent" type="checkbox" className="h-4 w-4" /> Keep me signed in
              </Label>
            )}
          </>
        )}
        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        {message && <p className="mt-3 text-sm text-emerald-400">{message}</p>}
          </CardContent>
          {mode !== "verify" && (
            <CardFooter className="flex-col gap-3">
            <Button className="w-full">
            {mode === "forgot" ? "Send reset link" : mode === "reset" ? "Reset password" : "Sign in"}
            </Button>
        {mode === "sign-in" && (
          <button
            type="button"
             className="w-full text-center text-xs text-blue-400 hover:text-blue-300"
            onClick={() => setMode("forgot")}
          >
            Forgot password?
          </button>
        )}
        {(mode === "forgot" || mode === "reset" || mode === "verify") && (
          <button
            type="button"
             className="w-full text-center text-xs text-blue-400 hover:text-blue-300"
            onClick={() => setMode("sign-in")}
          >
            Back to sign in
          </button>
        )}
            </CardFooter>
          )}
        </Card>
      </form>
    </main>
  );
}
function Tools() {
  const [providers, setProviders] = useState<Item[]>([]);
  const [show, setShow] = useState(false);
  const load = () => api("/api/providers").then(setProviders);
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: f.get("name"),
        kind: f.get("kind"),
        endpoint: f.get("endpoint"),
        configuration: { timeout: Number(f.get("timeout")) },
        schema: {},
      }),
    });
    setShow(false);
    void load();
  };
  return (
    <>
      <Header
        title="All Tools"
        subtitle="Central MCP and OpenAPI provider configuration."
        action={
          <Button onClick={() => setShow(!show)}>
            <Plus size={16} className="mr-2" />
            Add provider
          </Button>
        }
      />
      {show && (
        <Card className="mb-6">
          <form className="grid gap-3 md:grid-cols-4" onSubmit={create}>
            <input required name="name" placeholder="Display name" />
            <select name="kind">
              <option>MCP</option>
              <option>OpenAPI</option>
            </select>
            <input required name="endpoint" placeholder="Server URL or command" />
            <input name="timeout" type="number" defaultValue="5000" />
            <Button className="md:col-span-4">Save and discover</Button>
          </form>
        </Card>
      )}
      <div className="grid gap-4">
        {providers.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  <Cable size={16} className="text-blue-400" />
                  {p.name}
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{p.kind}</span>
                </div>
                <p className="mt-1 text-sm text-slate-500">{p.endpoint}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={p.status === "Available" ? "text-emerald-400" : "text-amber-400"}>
                  {p.disabled ? "Disabled" : p.status}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    await api(`/api/providers/${p.id}/test`, { method: "POST" });
                    void load();
                  }}
                >
                  Test connection
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {!providers.length && <Empty text="No providers are configured. Add MCP or OpenAPI tooling to begin." />}
      </div>
    </>
  );
}
function Agents() {
  const [agents, setAgents] = useState<Item[]>([]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState("");
  const load = () => api("/api/agents").then(setAgents);
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: f.get("name"), description: f.get("description") }),
    });
    setCreating(false);
    void load();
  };
  return (
    <>
      <Header
        title="Agents"
        subtitle="Stateless authorization and tool-presentation profiles, not running agents."
        action={
          <Button onClick={() => setCreating(!creating)}>
            <Plus size={16} className="mr-2" />
            New profile
          </Button>
        }
      />
      {creating && (
        <Card className="mb-6">
          <form onSubmit={create} className="grid gap-3 md:grid-cols-3">
            <input required name="name" placeholder="Profile name" />
            <input name="description" placeholder="Description" />
            <Button>Create profile</Button>
          </form>
        </Card>
      )}
      {secret && (
        <Card className="mb-6 border-blue-700">
          <p className="font-medium">Copy this credential now. It will not be shown again.</p>
          <code className="mt-3 block overflow-auto rounded bg-slate-950 p-3 text-blue-300">{secret}</code>
          <Button className="mt-3" variant="outline" onClick={() => setSecret("")}>
            I stored it
          </Button>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <div className="flex justify-between">
              <div>
                <h2 className="font-medium">{agent.name}</h2>
                <p className="mt-1 min-h-10 text-sm text-slate-400">{agent.description || "No description"}</p>
              </div>
              <span className={agent.enabled ? "text-emerald-400 text-sm" : "text-slate-500 text-sm"}>
                {agent.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="mt-5 flex items-center justify-between border-t pt-4 text-sm text-slate-400">
              <span>{agent.toolCount} exposed tools</span>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const r = await api(`/api/agents/${agent.id}/credentials`, {
                    method: "POST",
                    body: JSON.stringify({ name: "Admin-created credential" }),
                  });
                  setSecret(r.secret);
                }}
              >
                Generate credential
              </Button>
            </div>
          </Card>
        ))}
        {!agents.length && <Empty text="Profiles define only what an external harness may call." />}
      </div>
    </>
  );
}
function Projects() {
  const [projects, setProjects] = useState<Item[]>([]);
  const [show, setShow] = useState(false);
  const load = () => api("/api/projects").then(setProjects);
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: f.get("name"),
        description: f.get("description"),
        gitProvider: f.get("provider"),
        repository: f.get("repository"),
        defaultBranch: f.get("branch"),
        createDefaultDeveloperRole: true,
      }),
    });
    setShow(false);
    void load();
  };
  return (
    <>
      <Header
        title="Projects"
        subtitle="Repository-backed roles, worktrees, and isolated sandbox environments."
        action={
          <Button onClick={() => setShow(!show)}>
            <Plus size={16} className="mr-2" />
            Create project
          </Button>
        }
      />
      {show && (
        <Card className="mb-6">
          <form className="grid gap-3 md:grid-cols-2" onSubmit={create}>
            <input required name="name" placeholder="Project name" />
            <input name="description" placeholder="Description" />
            <select name="provider">
              <option>Gitea</option>
              <option>GitHub</option>
              <option>GitLab</option>
              <option>Generic</option>
              <option>Local</option>
            </select>
            <input name="repository" placeholder="Repository URL (optional)" />
            <input name="branch" defaultValue="main" />
            <label className="flex items-center gap-2 text-sm">
              <input checked readOnly type="checkbox" className="h-4 w-4" />
              Create default developer role
            </label>
            <Button className="md:col-span-2">Create project</Button>
          </form>
        </Card>
      )}
      <div className="grid gap-4">
        {projects.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="font-medium">{p.name}</h2>
                <p className="mt-1 text-sm text-slate-400">
                  {p.repository || "Local-only repository"} · {p.defaultBranch}
                </p>
              </div>
              <div className="flex gap-6 text-sm">
                <span>
                  <b>{p.roleCount}</b> roles
                </span>
                <span>
                  <b>{p.workspaceCount}</b> workspaces
                </span>
                <span className="text-blue-400">{p.gitProvider}</span>
              </div>
            </div>
          </Card>
        ))}
        {!projects.length && <Empty text="Create a project to configure roles and isolated coding workspaces." />}
      </div>
    </>
  );
}
function LegacyUsersPage() {
  const [users, setUsers] = useState<Item[]>([]);
  const load = () => api("/api/users").then(setUsers);
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <Header title="Users" subtitle="Platform access, administrative roles, and security status." />
      <Card>
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between border-b py-4 last:border-0">
            <div>
              <p className="font-medium">{user.displayName || user.email}</p>
              <p className="text-sm text-slate-500">{user.email}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded bg-slate-800 px-2 py-1 text-xs">{user.platformRole}</span>
              <Button
                variant={user.enabled ? "outline" : "default"}
                size="sm"
                onClick={async () => {
                  await api(`/api/users/${user.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: !user.enabled }),
                  });
                  void load();
                }}
              >
                {user.enabled ? "Disable" : "Enable"}
              </Button>
            </div>
          </div>
        ))}
        {!users.length && <Empty text="No users found." />}
      </Card>
    </>
  );
}
function Dashboard() {
  const [counts, setCounts] = useState({ providers: 0, agents: 0, projects: 0 });
  useEffect(() => {
    Promise.all([api("/api/providers"), api("/api/agents"), api("/api/projects")]).then(
      ([providers, agents, projects]) =>
        setCounts({ providers: providers.length, agents: agents.length, projects: projects.length }),
    );
  }, []);
  return (
    <>
      <Header title="Dashboard" subtitle="Platform health and configuration overview." />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["Providers", counts.providers, Cable],
          ["Agent profiles", counts.agents, Bot],
          ["Projects", counts.projects, FolderGit2],
        ].map(([label, count, Icon]: any) => (
          <Card key={label}>
            <Icon className="text-blue-400" />
            <p className="mt-6 text-3xl font-semibold">{count}</p>
            <p className="text-sm text-slate-400">{label}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-5">
        <div className="flex gap-3">
          <ShieldCheck className="text-emerald-400" />
          <div>
            <h2 className="font-medium">Control plane ready</h2>
            <p className="mt-1 text-sm text-slate-400">
              The web console configures infrastructure. External harnesses consume stateless agent and workspace APIs.
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <Card>
      <p className="text-sm text-slate-400">{text}</p>
    </Card>
  );
}
function App() {
  const [user, setUser] = useState<Item | null>(null);
  const [page, setPage] = useState("tools");
  const [agents, setAgents] = useState<Item[]>([]);
  const [projects, setProjects] = useState<Item[]>([]);
  useEffect(() => {
    if (localStorage.getItem("subpolar-token") || sessionStorage.getItem("subpolar-token"))
      api("/api/me")
        .then(setUser)
         .catch(() => {
           localStorage.removeItem("subpolar-token");
           sessionStorage.removeItem("subpolar-token");
          });
  }, []);
  useEffect(() => {
    if (!user) return;
    void Promise.all([api("/api/agents"), api("/api/projects")]).then(([nextAgents, nextProjects]) => {
      setAgents(nextAgents);
      setProjects(nextProjects);
    });
  }, [user]);
  if (!user) return <Login onLogin={setUser} />;
  const [pageType, pageId] = page.split(":");
  const signOut = () => {
    void api("/api/auth/sign-out", { method: "POST" });
    localStorage.removeItem("subpolar-token");
    sessionStorage.removeItem("subpolar-token");
    setUser(null);
  };
  const Page =
    pageType === "tools"
      ? () => <ToolsPage request={api} />
      : pageType === "agents"
        ? () => <AgentsPage request={api} initialId={pageId} />
        : pageType === "projects"
          ? () => <ProjectsPage request={api} initialId={pageId} />
          : pageType === "users"
            ? () => <UsersPage request={api} />
            : pageType === "settings"
              ? () => <SettingsPage request={api} user={user} onUser={setUser} onSignOut={signOut} />
               : () => <ToolsPage request={api} />;
  return (
    <div className="min-h-screen md:flex">
      <aside className="flex w-full shrink-0 flex-col border-b border-blue-950/80 bg-[#01030a] md:sticky md:top-0 md:h-screen md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center gap-3 p-5">
          <div className="grid h-8 w-8 place-items-center rounded bg-blue-500 text-white shadow-md shadow-blue-950/40">
            <Boxes size={18} />
          </div>
          <b>Subpolar Tools</b>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:flex-1 md:overflow-y-auto">
          <div className="mb-5">
            <div className="flex items-center justify-between px-3 pb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Agent profiles</p>
              <button
                aria-label="Create agent profile"
                title="Create agent profile"
                onClick={() => setPage("agents:create")}
                className="rounded p-1 text-blue-400 hover:bg-blue-950/60 hover:text-blue-300"
              >
                <Plus size={15} />
              </button>
            </div>
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setPage(`agents:${agent.id}`)}
                className={`flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm md:mb-1 md:w-full ${page === `agents:${agent.id}` ? "bg-blue-950/70 text-blue-300" : "text-slate-400 hover:bg-blue-950/40 hover:text-slate-100"}`}
              >
                <Bot size={16} />
                <span className="truncate">{agent.name}</span>
              </button>
            ))}
            {!agents.length && <p className="px-3 text-xs text-slate-600">No profiles yet</p>}
          </div>
          <div>
            <div className="flex items-center justify-between px-3 pb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">Projects</p>
              <button
                aria-label="Create project"
                title="Create project"
                onClick={() => setPage("projects:create")}
                className="rounded p-1 text-blue-400 hover:bg-blue-950/60 hover:text-blue-300"
              >
                <Plus size={15} />
              </button>
            </div>
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setPage(`projects:${project.id}`)}
                className={`flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm md:mb-1 md:w-full ${page === `projects:${project.id}` ? "bg-blue-950/70 text-blue-300" : "text-slate-400 hover:bg-blue-950/40 hover:text-slate-100"}`}
              >
                <FolderGit2 size={16} />
                <span className="truncate">{project.name}</span>
              </button>
            ))}
            {!projects.length && <p className="px-3 text-xs text-slate-600">No projects yet</p>}
          </div>
        </nav>
        <div className="border-t border-slate-800 p-3 md:mt-auto">
          {[{ id: "tools", label: "All Tools", icon: Cable }, { id: "settings", label: "Settings", icon: Settings }].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm ${pageType === id ? "bg-blue-950/70 text-blue-300" : "text-slate-400 hover:bg-blue-950/40 hover:text-slate-100"}`}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
      </aside>
      <main className="w-full p-5 md:p-10">
        <Page />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
