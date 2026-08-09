import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../api";
import { go } from "../../lib/nav";

interface ClientHit {
  id: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
}

interface JobHit {
  id: string;
  title: string | null;
  client_name: string | null;
  job_number: number | null;
  status: string | null;
}

function clientLabel(c: ClientHit): string {
  if (c.name?.trim()) return c.name.trim();
  const parts = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return parts || "Client";
}

export function GlobalSearch({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [jobs, setJobs] = useState<JobHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setClients([]);
      setJobs([]);
      return;
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setClients([]);
      setJobs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      Promise.all([
        api.get<{ clients: ClientHit[] }>(
          `/api/clients?search=${encodeURIComponent(q)}&limit=8`,
        ),
        api.get<{ jobs: JobHit[] }>(`/api/jobs?q=${encodeURIComponent(q)}`),
      ])
        .then(([cRes, jRes]) => {
          if (cancelled) return;
          setClients(cRes.clients ?? []);
          setJobs((jRes.jobs ?? []).slice(0, 8));
        })
        .catch(() => {
          if (cancelled) return;
          setClients([]);
          setJobs([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  if (!open) return null;

  const navigate = (path: string) => {
    onClose();
    go(path);
  };

  const qLen = query.trim().length;
  const empty = qLen >= 2 && !loading && clients.length === 0 && jobs.length === 0;

  return (
    <div class="global-search" role="dialog" aria-label="Search clients and jobs">
      <div class="global-search__bar">
        <button
          type="button"
          class="global-search__back"
          aria-label="Close search"
          onClick={onClose}
        >
          ←
        </button>
        <input
          ref={inputRef}
          class="global-search__input"
          type="search"
          placeholder="Search clients & jobs…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        {query && (
          <button
            type="button"
            class="global-search__clear"
            aria-label="Clear"
            onClick={() => setQuery("")}
          >
            ✕
          </button>
        )}
      </div>

      <div class="global-search__body">
        {qLen === 0 && (
          <div class="global-search__empty">
            <p class="global-search__empty-title">Search clients &amp; jobs</p>
            <p class="global-search__empty-hint">
              Type a name, phone number, or job #.
            </p>
          </div>
        )}
        {qLen === 1 && (
          <p class="global-search__hint global-search__hint--tight">Keep typing…</p>
        )}
        {loading && <p class="global-search__hint global-search__hint--tight">Searching…</p>}
        {empty && <p class="global-search__hint global-search__hint--tight">No matches</p>}

        {clients.length > 0 && (
          <section class="global-search__section">
            <h3 class="global-search__heading">Clients</h3>
            {clients.map((c) => (
              <button
                key={c.id}
                type="button"
                class="global-search__hit"
                onClick={() => navigate(`/clients/${c.id}`)}
              >
                <span class="global-search__hit-icon">👥</span>
                <span class="global-search__hit-main">
                  <span class="global-search__hit-title">{clientLabel(c)}</span>
                  {c.phone && (
                    <span class="global-search__hit-meta">{c.phone}</span>
                  )}
                </span>
              </button>
            ))}
          </section>
        )}

        {jobs.length > 0 && (
          <section class="global-search__section">
            <h3 class="global-search__heading">Jobs</h3>
            {jobs.map((j) => (
              <button
                key={j.id}
                type="button"
                class="global-search__hit"
                onClick={() => navigate(`/jobs/${j.id}`)}
              >
                <span class="global-search__hit-icon">🏗️</span>
                <span class="global-search__hit-main">
                  <span class="global-search__hit-title">
                    {j.job_number != null ? `#${j.job_number} · ` : ""}
                    {j.title ?? j.client_name ?? "Job"}
                  </span>
                  <span class="global-search__hit-meta">
                    {[j.client_name, j.status].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
