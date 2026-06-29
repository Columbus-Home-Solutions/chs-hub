/**
 * /photos top-level route — cross-job photo library.
 *
 * Pulls GET /api/photos (all jobs, newest-first) + GET /api/jobs for job-title
 * lookup. Thumbnails link through to the originals; clicking the job label
 * navigates to that job. No new API endpoints needed.
 */

import type { RoutableProps } from "preact-router";
import { useRouter } from "preact-router";
import { useEffect, useMemo, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Spinner } from "../../components/ui/Spinner";
import { go } from "../../lib/nav";
import { formatDateTime } from "../../lib/format";

interface PhotoItem {
  id: string;
  job_id: string | null;
  photo_type: string;
  caption: string | null;
  taken_at: string | null;
  is_annotated: boolean;
  before_after_pair_id: string | null;
  thumb_url: string;
  original_url: string;
}

interface JobStub {
  id: string;
  job_number: number | null;
  job_display: string | null;
  title: string | null;
  client_name: string | null;
  status: string | null;
}

const TYPE_OPTIONS = [
  { value: "", label: "All types" },
  { value: "job_progress", label: "Progress" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" },
  { value: "receipt", label: "Receipt" },
  { value: "punch_list", label: "Punch List" },
  { value: "issue", label: "Issue" },
  { value: "completion", label: "Completion" },
  { value: "general", label: "General" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  TYPE_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]),
);

export function PhotoLibrary(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const currentSearch = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const photosResp = useApi<{ total: number; photos: PhotoItem[] }>("/api/photos?limit=200");
  const jobsResp = useApi<{ total: number; jobs: JobStub[] }>("/api/jobs");
  const [typeFilter, setTypeFilter] = useState("");
  const [jobFilter, setJobFilter] = useState("");
  const [lightbox, setLightbox] = useState<PhotoItem | null>(null);
  const [uploadHint, setUploadHint] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(currentSearch);
    if (params.get("action") === "upload") {
      setUploadHint(true);
    }
  }, [currentSearch]);

  const photos = photosResp.data?.photos ?? [];
  const activeJobs = useMemo(() => {
    const terminal = new Set(["complete", "closed"]);
    return (jobsResp.data?.jobs ?? [])
      .filter((j) => !j.status || !terminal.has(j.status))
      .sort((a, b) => (b.job_number ?? 0) - (a.job_number ?? 0));
  }, [jobsResp.data?.jobs]);

  if (photosResp.loading) return <Spinner center />;

  const jobMap = new Map<string, JobStub>(activeJobs.map((j) => [j.id, j]));

  const filtered = photos.filter((p) => {
    if (typeFilter && p.photo_type !== typeFilter) return false;
    if (jobFilter && p.job_id !== jobFilter) return false;
    return true;
  });

  const jobFilterLabel = (j: JobStub) => {
    const num = j.job_display ?? (j.job_number != null ? `JOB-${String(j.job_number).padStart(3, "0")}` : "Job");
    const title = j.title ?? j.client_name ?? "";
    return title ? `${num} — ${title}` : num;
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Photos</h1>
          <p class="view-subtitle">
            {filtered.length} photo{filtered.length !== 1 ? "s" : ""} across all jobs
          </p>
        </div>
      </div>

      {uploadHint && (
        <div
          class="dash-card"
          style={{
            marginBottom: "var(--space-md)",
            padding: "var(--space-md)",
            background: "var(--color-brand-subtle)",
          }}
        >
          <strong>Add a photo:</strong> open a job and use the Photos tab to upload, or pick a job
          below to jump there.
          {activeJobs[0] && (
            <>
              {" "}
              <button
                type="button"
                class="link-btn"
                onClick={() => go(`/jobs/${activeJobs[0].id}`)}
              >
                Go to {jobFilterLabel(activeJobs[0])}
              </button>
            </>
          )}
        </div>
      )}

      {/* Filters */}
      <div class="flex gap-sm" style={{ marginBottom: "var(--space-md)", flexWrap: "wrap" }}>
        <select
          class="form-input"
          style={{ width: "auto", minWidth: "200px" }}
          value={jobFilter}
          onChange={(e) => setJobFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="">All Jobs</option>
          {activeJobs.map((j) => (
            <option key={j.id} value={j.id}>{jobFilterLabel(j)}</option>
          ))}
        </select>
        <select
          class="form-input"
          style={{ width: "auto", minWidth: "160px" }}
          value={typeFilter}
          onChange={(e) => setTypeFilter((e.target as HTMLSelectElement).value)}
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div class="empty-state">
          <div class="empty-state__icon">📸</div>
          <div class="empty-state__title">No photos</div>
          <div>Photos are captured inside each job's Photos tab.</div>
        </div>
      ) : (
        <div class="photo-grid">
          {filtered.map((p) => {
            const job = p.job_id ? jobMap.get(p.job_id) : undefined;
            const jobLabel = job
              ? (job.title ?? job.client_name ?? null)
              : null;
            return (
              <div
                key={p.id}
                class="photo-thumb"
                onClick={() => setLightbox(p)}
              >
                <img
                  class="photo-thumb__img"
                  src={p.thumb_url}
                  alt={p.caption ?? TYPE_LABEL[p.photo_type] ?? p.photo_type}
                  loading="lazy"
                />
                {p.is_annotated && (
                  <span class="photo-thumb__badge photo-thumb__badge--annot">✏️</span>
                )}
                {p.before_after_pair_id && (
                  <span class="photo-thumb__badge photo-thumb__badge--pair" style={{ right: "2rem" }}>↔️</span>
                )}
                <div class="photo-thumb__footer">
                  <span class="photo-thumb__type">
                    {TYPE_LABEL[p.photo_type] ?? p.photo_type}
                  </span>
                  {jobLabel && (
                    <span
                      class="photo-thumb__job"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (p.job_id) go(`/jobs/${p.job_id}`);
                      }}
                    >
                      {jobLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          class="photo-lightbox"
          onClick={() => setLightbox(null)}
        >
          <div class="photo-lightbox__inner" onClick={(e) => e.stopPropagation()}>
            <img class="photo-lightbox__img" src={lightbox.original_url} alt={lightbox.caption ?? ""} />
            <div class="photo-lightbox__meta">
              {lightbox.caption && <p>{lightbox.caption}</p>}
              {lightbox.taken_at && (
                <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                  {formatDateTime(lightbox.taken_at)}
                </p>
              )}
              {lightbox.job_id && (
                <button
                  class="btn btn--secondary btn--sm"
                  onClick={() => { setLightbox(null); go(`/jobs/${lightbox.job_id}`); }}
                >
                  Open Job →
                </button>
              )}
            </div>
            <button class="photo-lightbox__close" onClick={() => setLightbox(null)}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
