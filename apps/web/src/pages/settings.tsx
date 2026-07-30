import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Monitor, ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { UsersPage } from "./users";

type RecordItem = Record<string, any>;
type Request = (path: string, options?: RequestInit) => Promise<any>;

export function SettingsPage({
  request,
  user,
  onUser,
  onSignOut,
}: {
  request: Request;
  user: RecordItem;
  onUser(user: RecordItem): void;
  onSignOut(): void;
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
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck size={17} className="text-blue-400" />
            Profile
            </CardTitle>
          </CardHeader>
          <CardContent>
          <form className="space-y-3" onSubmit={profile}>
            <Label className="block space-y-2">
              Display name
              <Input name="displayName" defaultValue={user.displayName || ""} />
            </Label>
            <Label className="block space-y-2">
              Email
              <Input name="email" type="email" defaultValue={user.email} />
            </Label>
            <div className="flex flex-wrap gap-2">
              <Button>Save profile</Button>
              {!user.verified && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    await request("/api/me/request-verification", { method: "POST" });
                    setMessage("Verification email sent.");
                  }}
                >
                  Resend verification
                </Button>
              )}
            </div>
          </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound size={17} className="text-blue-400" />
            Password
          </CardTitle>
          </CardHeader>
          <CardContent>
          <form className="space-y-3" onSubmit={password}>
            <Label className="block space-y-2">
              Current password
              <Input required name="currentPassword" type="password" />
            </Label>
            <Label className="block space-y-2">
              New password
              <Input required name="password" minLength={12} type="password" />
            </Label>
            <Button>Change password</Button>
          </form>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-medium">
                <Monitor size={17} className="text-blue-400" />
                Active sessions
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Revoke access for browsers or devices you no longer recognize.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
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
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
            </div>
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
        </Card>
      </div>
      <div className="mt-10 border-t border-slate-800 pt-10">
        <UsersPage request={request} />
      </div>
    </div>
  );
}
