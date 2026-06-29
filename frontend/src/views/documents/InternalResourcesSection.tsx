import { useEffect, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { isOwner } from "../../lib/rbac";
import { useAuth } from "../../store/auth";

interface ResourceLink {
  id: string;
  label: string;
  url: string;
}

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

export function InternalResourcesSection() {
  const { user } = useAuth();
  const toast = useToast();
  const [driveUrl, setDriveUrl] = useState("");
  const [links, setLinks] = useState<ResourceLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [driveBusy, setDriveBusy] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ drive_url: string | null; links: ResourceLink[] }>(
        "/api/settings/internal-resources",
      );
      setDriveUrl(res.drive_url ?? "");
      setLinks(res.links ?? []);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOwner(user)) void load();
  }, [user]);

  if (!isOwner(user)) return null;

  const saveDrive = async () => {
    const url = driveUrl.trim();
    if (!url) {
      toast.push("info", "Enter a Google Drive folder URL first.");
      return;
    }
    setDriveBusy(true);
    try {
      await api.post("/api/settings/internal-resources/drive-url", { url });
      toast.push("success", "Drive link saved");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setDriveBusy(false);
    }
  };

  const addLink = async () => {
    const label = newLabel.trim();
    const url = newUrl.trim();
    if (!label || !url) {
      toast.push("info", "Label and URL are both required.");
      return;
    }
    setLinkBusy(true);
    try {
      await api.post("/api/settings/internal-resources/links", { label, url });
      toast.push("success", "Link saved");
      setNewLabel("");
      setNewUrl("");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLinkBusy(false);
    }
  };

  const deleteLink = async (id: string) => {
    try {
      await api.del(`/api/settings/internal-resources/links/${id}`);
      toast.push("success", "Link removed");
      setConfirmDeleteId(null);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <section class="internal-resources card mt-lg">
      <div class="card__header">
        <span class="card__title">Internal Resources</span>
        <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>Owner only</span>
      </div>
      <div class="card__body">
      {loading ? (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>Loading…</p>
      ) : (
        <>
          <div class="internal-resources__drive">
            <span class="internal-resources__drive-icon" aria-hidden="true">📁</span>
            <div class="internal-resources__drive-body">
              <FormField label="Company Google Drive">
                <input
                  class="form-input"
                  type="url"
                  placeholder="https://drive.google.com/drive/folders/…"
                  value={driveUrl}
                  onInput={(e) => setDriveUrl((e.target as HTMLInputElement).value)}
                />
              </FormField>
              <div class="flex gap-sm" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
                <Button variant="secondary" size="sm" disabled={driveBusy} onClick={() => void saveDrive()}>
                  {driveBusy ? "Saving…" : "Save Drive Link"}
                </Button>
                {driveUrl.trim() && (
                  <a
                    class="btn btn--sm btn--tertiary"
                    href={driveUrl.trim()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Drive ↗
                  </a>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: "var(--space-lg)" }}>
            <h3 class="card__title" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-sm)" }}>Quick Links</h3>
            {links.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                No quick links yet — add one below.
              </p>
            ) : (
              <ul class="internal-resources__list">
                {links.map((link) => (
                  <li class="internal-resources__item" key={link.id}>
                    <span>{link.label}</span>
                    <div class="flex gap-sm items-center">
                      <a
                        class="btn btn--sm btn--secondary"
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open ↗
                      </a>
                      {confirmDeleteId === link.id ? (
                        <span class="flex gap-xs items-center" style={{ fontSize: "var(--text-sm)" }}>
                          <span class="text--muted">Are you sure?</span>
                          <button type="button" class="link-btn" onClick={() => void deleteLink(link.id)}>
                            Confirm
                          </button>
                          <button type="button" class="link-btn" onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setConfirmDeleteId(link.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div class="internal-resources__add-form" style={{ marginTop: "var(--space-md)" }}>
            <h3 class="card__title" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-sm)" }}>+ Add Link</h3>
            <div class="form-row form-row--align-end">
              <FormField label="Label">
                <input
                  class="form-input"
                  value={newLabel}
                  placeholder="SOP — Estimating Process"
                  onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
                />
              </FormField>
              <FormField label="URL">
                <input
                  class="form-input"
                  type="url"
                  value={newUrl}
                  placeholder="https://…"
                  onInput={(e) => setNewUrl((e.target as HTMLInputElement).value)}
                />
              </FormField>
              <div class="form-row__action">
                <Button variant="primary" size="sm" disabled={linkBusy} onClick={() => void addLink()}>
                  {linkBusy ? "Saving…" : "Save Link"}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    </section>
  );
}
