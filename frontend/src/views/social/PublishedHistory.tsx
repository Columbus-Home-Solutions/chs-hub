import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus, formatDateTime } from "../../lib/format";
import { SOCIAL_TYPE_COLORS, type SocialPost } from "../../types";
import { PhotoTile, postTypeLabel } from "./PhotoTile";

interface Props {
  onEdit: (id: string) => void;
  refreshKey: number;
}

/** Published history (spec §5.5): table of published + failed posts with
 *  platform links and status. */
export function PublishedHistory({ onEdit, refreshKey }: Props) {
  const toast = useToast();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("published");

  const load = async () => {
    setLoading(true);
    try {
      const q = statusFilter ? `?status=${statusFilter}` : "";
      const r = await api.get<{ posts: SocialPost[] }>(`/api/social-posts${q}`);
      setPosts(r.posts);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, refreshKey]);

  return (
    <Card>
      <div class="flex gap-md items-end mb-md flex-wrap">
        <div style={{ minWidth: 180 }}>
          <label class="form-label">Status</label>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "published", label: "Published" },
              { value: "failed", label: "Failed" },
              { value: "rejected", label: "Rejected" },
              { value: "scheduled", label: "Scheduled" },
            ]}
          />
        </div>
      </div>

      {loading && <Spinner center />}
      {!loading && posts.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__title">No {formatStatus(statusFilter)} posts yet.</div>
        </div>
      )}

      {!loading && posts.length > 0 && (
        <div>
          {posts.map((p) => (
            <div key={p.id} class="history-row" onClick={() => onEdit(p.id)}>
              <PhotoTile post={p} size="sm" />
              <div class="history-row__copy">
                <div class="flex gap-sm items-center flex-wrap">
                  <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[p.post_type] }} />
                  <strong>{postTypeLabel(p.post_type)}</strong>
                  <Badge status={p.status}>{formatStatus(p.status)}</Badge>
                  <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                    {formatDateTime(p.published_date ?? p.scheduled_date)}
                  </span>
                </div>
                <div class="social-cal__post-label">{p.caption}</div>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <PlatformPills post={p} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PlatformPills({ post }: { post: SocialPost }) {
  const showFb = post.platform !== "instagram_only";
  const showIg = post.platform !== "facebook_only";
  return (
    <span class="flex gap-sm flex-wrap">
      {showFb &&
        (post.facebook_url ? (
          <a class="platform-pill platform-pill--fb" href={post.facebook_url} target="_blank" rel="noreferrer">
            Facebook
          </a>
        ) : (
          <span class="platform-pill platform-pill--fb platform-pill--off">Facebook</span>
        ))}
      {showIg &&
        (post.instagram_url ? (
          <a class="platform-pill platform-pill--ig" href={post.instagram_url} target="_blank" rel="noreferrer">
            Instagram
          </a>
        ) : (
          <span class="platform-pill platform-pill--ig platform-pill--off">Instagram</span>
        ))}
    </span>
  );
}
