import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Monitor, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/button";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function SettingsPage({
  request,
  user,
  onUser,
}: {
  request: Request;
  user: RecordItem;
  onUser(user: RecordItem): void;
}) {
  const [sessions, setSessions] = useState<RecordItem[]>([]);
  const [message, setMessage] = useState("");
  const load = () => request("/api/me/sessions").then(setSessions);
  useEffect(() => {
    void load();
  }, []);
  const profile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = await request("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ displayName: form.get("displayName"), email: form.get("email") }),
    });
    onUser(next);
    setMessage("Profile updated. Email changes require verification.");
  };
  const password = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await request("/api/me/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: form.get("currentPassword"), password: form.get("password") }),
    });
    setMessage("Password changed. All sessions have been revoked.");
  };
  const revoke = async (id: string) => {
    await request(`/api/me/sessions/${id}/revoke`, { method: "POST" });
    await load();
  };
  return (
    <div>
      <div className="mb-7">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">Manage your account, password, and active sessions.</p>
      </div>
      {message && (
        <div className="mb-5 rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {message}
        </div>
      )}
      <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
        <section className="rounded-xl border bg-slate-900/60 p-5">
          <h2 className="flex items-center gap-2 font-medium">
            <ShieldCheck size={17} className="text-cyan-400" />
            Profile
          </h2>
          <form className="mt-4 space-y-3" onSubmit={profile}>
            <label className="block text-sm">
              Display name
              <input name="displayName" defaultValue={user.displayName || ""} />
            </label>
            <label className="block text-sm">
              Email
              <input name="email" type="email" defaultValue={user.email} />
            </label>
            <Button>Save profile</Button>
          </form>
        </section>
        <section className="rounded-xl border bg-slate-900/60 p-5">
          <h2 className="flex items-center gap-2 font-medium">
            <KeyRound size={17} className="text-cyan-400" />
            Password
          </h2>
          <form className="mt-4 space-y-3" onSubmit={password}>
            <label className="block text-sm">
              Current password
              <input required name="currentPassword" type="password" />
            </label>
            <label className="block text-sm">
              New password
              <input required name="password" minLength={12} type="password" />
            </label>
            <Button>Change password</Button>
          </form>
        </section>
        <section className="rounded-xl border bg-slate-900/60 p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-medium">
                <Monitor size={17} className="text-cyan-400" />
                Active sessions
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Revoke access for browsers or devices you no longer recognize.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await request("/api/me/sessions/revoke-all", { method: "POST" });
                await load();
              }}
            >
              Sign out all devices
            </Button>
          </div>
          <div className="mt-4 divide-y divide-slate-800">
            {sessions.map((session) => (
              <div className="flex flex-wrap items-center justify-between gap-3 py-3" key={session.id}>
                <div>
                  <p className="text-sm font-medium">{session.label || "Browser"}</p>
                  <p className="text-xs text-slate-500">
                    Last used {session.lastUsed || "Never"} · expires {session.expiresAt}
                  </p>
                </div>
                <Button variant="outline" size="sm" disabled={session.revoked} onClick={() => void revoke(session.id)}>
                  {session.revoked ? "Revoked" : "Revoke"}
                </Button>
              </div>
            ))}
            {!sessions.length && <p className="py-3 text-sm text-slate-500">No sessions found.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
