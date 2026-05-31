import { useEffect, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatDate } from "../../lib/format";
import type { PhotoItem } from "./PhotosTab";

interface DailyLog {
  id: string;
  log_date: string;
  weather: string | null;
  work_performed: string;
  issues: string | null;
  materials_used: string | null;
  crew_on_site: string | null;
  hours_worked: number | null;
  photo_ids: string[];
  entered_via: string;
  photos: { id: string; thumb_url: string; original_url: string; caption: string | null }[];
}

export function DailyLogsTab({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const { data, loading, error, refetch } = useApi<{ daily_logs: DailyLog[] }>(`/api/jobs/${jobId}/daily-logs`);
  const logs = data?.daily_logs ?? [];

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>{logs.length} daily log(s)</span>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Daily Log</Button>
      </div>

      {loading ? (
        <Spinner center />
      ) : error ? (
        <div class="empty-state"><div class="empty-state__title">Couldn't load logs</div><div>{error}</div></div>
      ) : logs.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📝</div>
          <div class="empty-state__title">No daily logs yet</div>
          <div>Record what was done on site each day, with weather, crew and photos.</div>
        </div>
      ) : (
        logs.map((log) => (
          <Card key={log.id} title={formatDate(log.log_date)} actions={log.weather ? <span class="text--muted">{log.weather}</span> : undefined}>
            <div class="stack">
              <div>{log.work_performed}</div>
              {log.issues && <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>⚠️ {log.issues}</div>}
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                {log.crew_on_site ? `👷 ${log.crew_on_site}` : ""}
                {log.hours_worked != null ? ` · ⏱ ${log.hours_worked}h` : ""}
                {log.materials_used ? ` · 📦 ${log.materials_used}` : ""}
              </div>
              {log.photos.length > 0 && (
                <div class="photo-grid photo-grid--sm">
                  {log.photos.map((p) => (
                    <a key={p.id} class="photo-thumb" href={p.original_url} target="_blank" rel="noreferrer">
                      <img src={p.thumb_url} alt={p.caption ?? "log photo"} loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </Card>
        ))
      )}

      {addOpen && (
        <AddDailyLogModal
          jobId={jobId}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); refetch(); toast.push("success", "Daily log saved"); }}
          toast={toast}
        />
      )}
    </div>
  );
}

function AddDailyLogModal({
  jobId,
  onClose,
  onAdded,
  toast,
}: {
  jobId: string;
  onClose: () => void;
  onAdded: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [work, setWork] = useState("");
  const [weather, setWeather] = useState("");
  const [issues, setIssues] = useState("");
  const [materials, setMaterials] = useState("");
  const [crew, setCrew] = useState("");
  const [hours, setHours] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dayPhotos, setDayPhotos] = useState<PhotoItem[]>([]);

  // Offer photos taken on the selected day for "photo of the day" linking.
  useEffect(() => {
    let active = true;
    const from = `${logDate}T00:00:00Z`;
    const to = `${logDate}T23:59:59Z`;
    api
      .get<{ photos: PhotoItem[] }>(`/api/jobs/${jobId}/photos?from=${from}&to=${to}`)
      .then((d) => { if (active) setDayPhotos(d.photos); })
      .catch(() => { if (active) setDayPhotos([]); });
    return () => { active = false; };
  }, [jobId, logDate]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const submit = async () => {
    if (!work.trim()) {
      toast.push("error", "Work performed is required");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/daily-logs`, {
        log_date: logDate,
        work_performed: work.trim(),
        weather: weather.trim() || null,
        issues: issues.trim() || null,
        materials_used: materials.trim() || null,
        crew_on_site: crew.trim() || null,
        hours_worked: hours ? Number(hours) : null,
        photo_ids: Array.from(picked),
        entered_via: "web",
      });
      onAdded();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="New Daily Log"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Save Log"}</Button>
        </>
      }
    >
      <div class="flex gap-sm">
        <FormField label="Date" required>
          <input class="form-input" type="date" value={logDate} onInput={(e) => setLogDate((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Weather">
          <input class="form-input" value={weather} placeholder="e.g. Clear, 68F" onInput={(e) => setWeather((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Work performed" required>
        <textarea class="form-input" rows={3} value={work} onInput={(e) => setWork((e.target as HTMLTextAreaElement).value)} />
      </FormField>
      <FormField label="Issues">
        <textarea class="form-input" rows={2} value={issues} onInput={(e) => setIssues((e.target as HTMLTextAreaElement).value)} />
      </FormField>
      <div class="flex gap-sm">
        <FormField label="Crew on site">
          <input class="form-input" value={crew} onInput={(e) => setCrew((e.target as HTMLInputElement).value)} />
        </FormField>
        <FormField label="Hours">
          <input class="form-input" type="number" step="0.5" value={hours} onInput={(e) => setHours((e.target as HTMLInputElement).value)} />
        </FormField>
      </div>
      <FormField label="Materials used">
        <input class="form-input" value={materials} onInput={(e) => setMaterials((e.target as HTMLInputElement).value)} />
      </FormField>

      <FormField label={`Link photos taken ${formatDate(logDate)} (${picked.size} selected)`}>
        {dayPhotos.length === 0 ? (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>No photos captured that day.</div>
        ) : (
          <div class="photo-grid photo-grid--sm">
            {dayPhotos.map((p) => (
              <button
                key={p.id}
                type="button"
                class={`photo-thumb${picked.has(p.id) ? " photo-thumb--picked" : ""}`}
                onClick={() => toggle(p.id)}
              >
                <img src={p.thumb_url} alt={p.caption ?? "photo"} loading="lazy" />
                {picked.has(p.id) && <span class="photo-thumb__check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </FormField>
    </Modal>
  );
}
