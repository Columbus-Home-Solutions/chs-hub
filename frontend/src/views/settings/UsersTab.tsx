import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { ROLE_LABELS, ROLE_CAPABILITY_SUMMARY } from "../../lib/rbac";
import type { CurrentUser } from "../../store/auth";

type Role = CurrentUser["role"];

interface ManagedUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  name: string;
  phone: string | null;
  role: Role;
  is_active: boolean;
  last_login: string | null;
  notification_preferences: Record<string, boolean> | null;
}

const ROLE_OPTIONS = (Object.keys(ROLE_LABELS) as Role[]).map((r) => ({ value: r, label: ROLE_LABELS[r] }));
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function UsersTab() {
  const toast = useToast();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [prefsFor, setPrefsFor] = useState<ManagedUser | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ users: ManagedUser[] }>("/api/users");
      setUsers(r.users);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggleActive = async (u: ManagedUser) => {
    try {
      await api.put(`/api/users/${u.id}`, { is_active: !u.is_active });
      toast.push("success", u.is_active ? "User deactivated" : "User reactivated");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <Card
      title="Users"
      actions={
        <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
          + Add User
        </Button>
      }
    >
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: 0 }}>
        Users are never deleted — deactivate to block login while preserving their audit trail.
        Login identity is provisioned through Cloudflare Access (add the email to the Access policy).
      </p>
      {loading ? (
        <Spinner center />
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td class="text--mono">{u.email}</td>
                <td>{ROLE_LABELS[u.role]}</td>
                <td>
                  {u.is_active ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Deactivated</Badge>}
                </td>
                <td class="text--muted">{u.last_login ? new Date(u.last_login).toLocaleDateString() : "—"}</td>
                <td>
                  <div class="flex gap-sm">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="tertiary" onClick={() => setPrefsFor(u)}>
                      Notifications
                    </Button>
                    <Button
                      size="sm"
                      variant={u.is_active ? "danger" : "secondary"}
                      onClick={() => toggleActive(u)}
                    >
                      {u.is_active ? "Deactivate" : "Reactivate"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <UserModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {editing && (
        <UserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {prefsFor && (
        <NotificationPrefsModal
          user={prefsFor}
          onClose={() => setPrefsFor(null)}
          onSaved={() => {
            setPrefsFor(null);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function RolePreview({ role }: { role: Role }) {
  return (
    <div class="role-preview">
      <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-xs)" }}>
        {ROLE_LABELS[role]} can:
      </div>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "var(--text-sm)" }}>
        {ROLE_CAPABILITY_SUMMARY[role].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function UserModal({
  user,
  onClose,
  onSaved,
}: {
  user?: ManagedUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const editingExisting = Boolean(user);
  const [email, setEmail] = useState(user?.email ?? "");
  const [firstName, setFirstName] = useState(user?.first_name ?? "");
  const [lastName, setLastName] = useState(user?.last_name ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "field_crew");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (editingExisting && user) {
        await api.put(`/api/users/${user.id}`, {
          first_name: firstName,
          last_name: lastName,
          phone,
          role,
        });
        toast.push("success", "User updated");
      } else {
        const res = await api.post<{ invite: { sent: boolean; mode: string } }>("/api/users", {
          email,
          first_name: firstName,
          last_name: lastName,
          phone,
          role,
        });
        toast.push(
          "success",
          res.invite.sent ? "User created — invite sent" : `User created — invite ${res.invite.mode}d (logged)`,
        );
      }
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={editingExisting ? "Edit user" : "Add user"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (!editingExisting && !email)} onClick={save}>
            {editingExisting ? "Save" : "Create + invite"}
          </Button>
        </>
      }
    >
      <FormField label="Email" required>
        <input
          class="form-input"
          type="email"
          value={email}
          disabled={editingExisting}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <div class="form-row">
        <FormField label="First name">
          <input class="form-input" value={firstName} onInput={(e) => setFirstName((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Last name">
          <input class="form-input" value={lastName} onInput={(e) => setLastName((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Phone">
        <input class="form-input" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Role" required>
        <Select value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as Role)} />
      </FormField>
      <RolePreview role={role} />
    </Modal>
  );
}

const CHANNELS: { key: string; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "push", label: "Push (Sprint 18)" },
  { key: "in_app", label: "In-app" },
];

function NotificationPrefsModal({
  user,
  onClose,
  onSaved,
}: {
  user: ManagedUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({
    email: user.notification_preferences?.email ?? true,
    sms: user.notification_preferences?.sms ?? false,
    push: user.notification_preferences?.push ?? false,
    in_app: user.notification_preferences?.in_app ?? true,
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/users/${user.id}/notification-preferences`, { notification_preferences: prefs });
      toast.push("success", "Preferences saved");
      onSaved();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={`Notification preferences — ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {CHANNELS.map((c) => (
        <label key={c.key} class="flex items-center gap-sm" style={{ padding: "var(--space-xs) 0" }}>
          <input
            type="checkbox"
            checked={prefs[c.key]}
            disabled={c.key === "push"}
            onChange={(e) => setPrefs({ ...prefs, [c.key]: (e.target as HTMLInputElement).checked })}
          />
          <span>{c.label}</span>
        </label>
      ))}
    </Modal>
  );
}
