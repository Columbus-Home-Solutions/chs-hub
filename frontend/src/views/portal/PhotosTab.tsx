import { useEffect, useState } from "preact/hooks";
import { formatDate } from "../../lib/format";
import { getJson, type PortalPhoto } from "./portalApi";

/** Chronological, date-grouped photo timeline (client-visible photos only). */
export function PhotosTab({ token }: { token: string }) {
  const [photos, setPhotos] = useState<PortalPhoto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<PortalPhoto | null>(null);

  useEffect(() => {
    getJson<{ photos: PortalPhoto[] }>(`/api/portal/${token}/photos`)
      .then((r) => setPhotos(r.photos))
      .catch((e) => setError((e as Error).message));
  }, [token]);

  if (error) return <div class="quote-error">{error}</div>;
  if (!photos) return <div class="quote-muted">Loading photos…</div>;
  if (photos.length === 0) {
    return <Empty icon="📸" title="No photos yet" body="Progress photos will appear here as work moves along." />;
  }

  const groups = groupByDay(photos);

  return (
    <div class="portal-photos">
      {groups.map(([day, items]) => (
        <div class="portal-photos__group" key={day}>
          <div class="portal-photos__day">{formatDate(day)}</div>
          <div class="portal-photos__grid">
            {items.map((p) => (
              <button class="portal-photo" key={p.id} onClick={() => setActive(p)}>
                <img src={p.thumb_url} alt={p.caption ?? "Project photo"} loading="lazy" />
                {p.caption && <span class="portal-photo__caption">{p.caption}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}

      {active && (
        <div class="portal-lightbox" onClick={() => setActive(null)}>
          <button class="portal-lightbox__close" aria-label="Close">×</button>
          <img src={active.image_url} alt={active.caption ?? "Project photo"} onClick={(e) => e.stopPropagation()} />
          {active.caption && <div class="portal-lightbox__caption">{active.caption}</div>}
        </div>
      )}
    </div>
  );
}

function groupByDay(photos: PortalPhoto[]): [string, PortalPhoto[]][] {
  const map = new Map<string, PortalPhoto[]>();
  for (const p of photos) {
    const day = (p.taken_at ?? "").slice(0, 10) || "Undated";
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(p);
  }
  return Array.from(map.entries());
}

function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div class="portal-empty">
      <div class="portal-empty__icon">{icon}</div>
      <div class="portal-empty__title">{title}</div>
      <div class="quote-muted">{body}</div>
    </div>
  );
}
