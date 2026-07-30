import { useEffect, useState, type FormEvent } from "react";
import { History, Plus, UserRound } from "lucide-react";
import { Button } from "../components/ui/button";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function UsersPage({ request }: { request: Request }) {
  const [users, setUsers] = useState<RecordItem[]>([]);
  const [events, setEvents] = useState<RecordItem[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [sessions, setSessions] = useState<RecordItem[]>([]);
  const [agents, setAgents] = useState<RecordItem[]>([]);
  const [projects, setProjects] = useState<RecordItem[]>([]);
  const [grants, setGrants] = useState<{ agentIds: string[]; projectIds: string[] }>({ agentIds: [], projectIds: [] });
  const [retentionDays, setRetentionDays] = useState(365);
  const [auditFilters, setAuditFilters] = useState({ action: "", actorId: "", resource: "", resourceType: "" });
  const load = async () => {
    const [nextUsers, audit, nextAgents, nextProjects] = await Promise.all([
      request("/api/users"),
      request("/api/audit-events"),
      request("/api/agents"),
      request("/api/projects"),
    ]);
    setUsers(nextUsers);
    setEvents(audit.events);
    setRetentionDays(audit.retentionDays);
    setAgents(nextAgents);
    setProjects(nextProjects);
  };
  useEffect(() => {
    void load();
  }, []);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await request("/api/users", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          displayName: form.get("displayName"),
          platformRole: form.get("platformRole"),
          password: form.get("password"),
        }),
      });
      setShowCreate(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "User creation failed");
    }
  };
  const update = async (user: RecordItem, data: object) => {
    await request(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify(data) });
    await load();
  };
  const showSessions = async (user: RecordItem) => {
    setSelected(user);
    const [nextSessions, nextGrants] = await Promise.all([
      request(`/api/users/${user.id}/sessions`),
      request(`/api/users/${user.id}/grants`),
    ]);
    setSessions(nextSessions);
    setGrants(nextGrants);
  };
  const loadEvents = async (filters = auditFilters) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    const audit = await request(`/api/audit-events${params.size ? `?${params}` : ""}`);
    setEvents(audit.events);
    setRetentionDays(audit.retentionDays);
  };
  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    try {
      await request(`/api/users/${selected.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: form.get("password") }),
      });
      event.currentTarget.reset();
      setError("");
      await Promise.all([showSessions(selected), loadEvents()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password reset failed");
    }
  };
  const toggleGrant = (type: "agentIds" | "projectIds", id: string) =>
    setGrants((current) => ({
      ...current,
      [type]: current[type].includes(id) ? current[type].filter((item) => item !== id) : [...current[type], id],
    }));
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-1 text-sm text-slate-400">Platform roles, account status, sessions, and security events.</p>
        </div>
        <Button onClick={() => setShowCreate(!showCreate)}>
          <Plus size={16} className="mr-2" />
          Create user
        </Button>
      </div>
      {error && (
        <div className="mb-5 rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">{error}</div>
      )}
      {showCreate && (
        <form className="mb-6 grid gap-3 rounded-xl border bg-slate-950/70 p-5 md:grid-cols-2" onSubmit={create}>
          <input required name="displayName" placeholder="Display name" />
          <input required name="email" type="email" placeholder="Email" />
          <select name="platformRole">
            <option>User</option>
            <option>Admin</option>
          </select>
          <input required minLength={12} name="password" type="password" placeholder="Initial password" />
          <Button className="md:col-span-2">Create user</Button>
        </form>
      )}
      <div className="grid gap-5 xl:grid-cols-[1fr_23rem]">
        <section className="rounded-xl border bg-slate-950/70 p-5">
          <h2 className="flex items-center gap-2 font-medium">
            <UserRound size={17} className="text-blue-400" />
            Accounts
          </h2>
          <div className="mt-3 divide-y divide-slate-800">
            {users.map((user) => (
              <div className="flex flex-wrap items-center justify-between gap-3 py-4" key={user.id}>
                <div>
                  <p className="font-medium">{user.displayName || user.email}</p>
                  <p className="text-sm text-slate-500">{user.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="w-auto py-1.5 text-xs"
                    value={user.platformRole}
                    onChange={(event) => void update(user, { platformRole: event.target.value })}
                  >
                    <option>Admin</option>
                    <option>User</option>
                  </select>
                  <Button variant="outline" size="sm" onClick={() => void update(user, { enabled: !user.enabled })}>
                    {user.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      await request(`/api/users/${user.id}/revoke-sessions`, { method: "POST" });
                      await load();
                    }}
                  >
                    Revoke sessions
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void showSessions(user)}>
                    Sessions
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-xl border bg-slate-950/70 p-5">
          <h2 className="flex items-center gap-2 font-medium">
            <History size={17} className="text-blue-400" />
            Security events
          </h2>
          <form
            className="mt-3 grid grid-cols-2 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadEvents();
            }}
          >
            <input
              className="py-1.5 text-xs"
              placeholder="Action"
              value={auditFilters.action}
              onChange={(event) => setAuditFilters((current) => ({ ...current, action: event.target.value }))}
            />
            <select
              className="py-1.5 text-xs"
              value={auditFilters.actorId}
              onChange={(event) => setAuditFilters((current) => ({ ...current, actorId: event.target.value }))}
            >
              <option value="">All actors</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName || user.email}
                </option>
              ))}
            </select>
            <input
              className="py-1.5 text-xs"
              placeholder="Resource ID"
              value={auditFilters.resource}
              onChange={(event) => setAuditFilters((current) => ({ ...current, resource: event.target.value }))}
            />
            <select
              className="py-1.5 text-xs"
              value={auditFilters.resourceType}
              onChange={(event) => setAuditFilters((current) => ({ ...current, resourceType: event.target.value }))}
            >
              <option value="">All resources</option>
              <option value="user">Users</option>
              <option value="session">Sessions</option>
              <option value="provider">Providers</option>
              <option value="agent">Agents</option>
              <option value="project">Projects</option>
            </select>
            <Button className="col-span-2" size="sm" variant="outline">
              Apply filters
            </Button>
          </form>
          <p className="mt-3 text-xs text-slate-500">Events are retained for {retentionDays} days.</p>
          <div className="mt-3 max-h-[34rem] space-y-3 overflow-auto">
            {events.map((event) => (
              <div className="border-b border-slate-800 pb-3 text-sm" key={event.id}>
                <p className="font-medium">{event.action}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {event.actor?.displayName || event.actor?.email || event.actor?.id || "Unknown actor"} ·{" "}
                  {event.resourceDetails?.type || "resource"}:{" "}
                  {event.resourceDetails?.label || event.resourceDetails?.id || event.resource}
                </p>
                <p className="mt-1 text-xs text-slate-500">{event.created || "Unknown time"}</p>
              </div>
            ))}
            {!events.length && <p className="text-sm text-slate-500">No events recorded.</p>}
          </div>
        </section>
      </div>
      {selected && (
        <section className="mt-5 rounded-xl border bg-slate-950/70 p-5">
          <h2 className="font-medium">Sessions and access for {selected.displayName || selected.email}</h2>
          <div className="mt-3 space-y-2">
            {sessions.map((session) => (
              <div key={session.id} className="flex justify-between rounded border p-3 text-sm">
                <span>
                  {session.label || "Browser"}
                  <br />
                  <small className="text-slate-500">
                    Issued {session.created || "Unknown"} · last used {session.lastUsed || "Never"} · expires{" "}
                    {session.expiresAt}
                  </small>
                </span>
                <span className="flex items-center gap-2">
                  {session.revoked ? "Revoked" : "Active"}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={session.revoked}
                    onClick={async () => {
                      await request(`/api/users/${selected.id}/sessions/${session.id}/revoke`, { method: "POST" });
                      await Promise.all([showSessions(selected), loadEvents()]);
                    }}
                  >
                    Revoke
                  </Button>
                </span>
              </div>
            ))}
          </div>
          <form
            className="mt-5 max-w-md space-y-3 rounded-lg border border-amber-900/70 bg-amber-950/20 p-4"
            onSubmit={resetPassword}
          >
            <div>
              <h3 className="text-sm font-medium">Reset password</h3>
              <p className="mt-1 text-xs text-slate-400">
                Sets a new password and immediately revokes every session for this account.
              </p>
            </div>
            <input
              required
              minLength={12}
              name="password"
              type="password"
              placeholder="New password (12 characters minimum)"
            />
            <Button variant="outline">Reset password and revoke sessions</Button>
          </form>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <fieldset>
              <legend className="text-sm font-medium">Agent profiles</legend>
              {agents.map((agent) => (
                <label className="mt-2 flex gap-2 text-sm" key={agent.id}>
                  <input
                    type="checkbox"
                    checked={grants.agentIds.includes(agent.id)}
                    onChange={() => toggleGrant("agentIds", agent.id)}
                  />
                  {agent.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Projects</legend>
              {projects.map((project) => (
                <label className="mt-2 flex gap-2 text-sm" key={project.id}>
                  <input
                    type="checkbox"
                    checked={grants.projectIds.includes(project.id)}
                    onChange={() => toggleGrant("projectIds", project.id)}
                  />
                  {project.name}
                </label>
              ))}
            </fieldset>
          </div>
          <Button
            className="mt-5"
            onClick={() =>
              void request(`/api/users/${selected.id}/grants`, { method: "PUT", body: JSON.stringify(grants) })
            }
          >
            Save access grants
          </Button>
        </section>
      )}
    </div>
  );
}
