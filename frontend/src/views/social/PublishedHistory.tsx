import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus, formatDateTime } from "../../lib/format";
import { SOCIAL_POST_TYPES, SOCIAL_TYPE_COLORS, type SocialPost } from "../../types";

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
        <div class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Caption</th>
                <th>Status</th>
                <th>Date</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => onEdit(p.id)}>
                  <td>
                    <span class="flex gap-sm items-center">
                      <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[p.post_type] }} />
                      {labelFor(p.post_type)}
                    </span>
                  </td>
                  <td style={{ maxWidth: 360 }}>
                    <span class="social-cal__post-label" style={{ display: "block" }}>
                      {p.caption}
                    </span>
                  </td>
                  <td>
                    <Badge status={p.status}>{formatStatus(p.status)}</Badge>
                  </td>
                  <td>{formatDateTime(p.published_date ?? p.scheduled_date)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span class="flex gap-sm">
                      {p.facebook_url && (
                        <a href={p.facebook_url} target="_blank" rel="noreferrer">
                          FB↗
                        </a>
                      )}
                      {p.instagram_url && (
                        <a href={p.instagram_url} target="_blank" rel="noreferrer">
                          IG↗
                        </a>
                      )}
                      {!p.facebook_url && !p.instagram_url && <span class="text--muted">—</span>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function labelFor(type: string): string {
  return SOCIAL_POST_TYPES.find((t) => t.value === type)?.label ?? formatStatus(type);
}
