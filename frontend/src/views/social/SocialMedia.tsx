import type { RoutableProps } from "preact-router";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus, formatDateTime } from "../../lib/format";
import { SOCIAL_TYPE_COLORS, type SocialPost } from "../../types";
import { ApprovalQueue } from "./ApprovalQueue";
import { ContentCalendar } from "./ContentCalendar";
import { PublishedHistory } from "./PublishedHistory";
import { PostEditor } from "./PostEditor";

type Tab = "dashboard" | "calendar" | "queue" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "calendar", label: "Content Calendar" },
  { id: "queue", label: "Approval Queue" },
  { id: "history", label: "Published History" },
];

export function SocialMedia(_props: RoutableProps) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [editId, setEditId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const suppressEditUntil = useRef(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const openEditor = (id: string) => {
    if (Date.now() < suppressEditUntil.current) return;
    setEditId(id);
  };

  const closeEditor = () => {
    suppressEditUntil.current = Date.now() + 400;
    setEditId(null);
  };

  const newPost = async () => {
    setCreating(true);
    try {
      const r = await api.post<{ post: SocialPost }>("/api/social-posts", {
        caption: "",
        post_type: "manual",
        platform: "both",
      });
      bump();
      openEditor(r.post.id);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">Social Media</h1>
          <p class="view-subtitle">
            AI-assisted content for Facebook &amp; Instagram. Publishing runs in SIMULATE mode.
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="primary" onClick={() => void newPost()} disabled={creating}>
            {creating ? "Creating…" : "+ New post"}
          </Button>
        </div>
      </div>

      <div class="job-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={`job-tab${tab === t.id ? " job-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab refreshKey={refreshKey} onEdit={openEditor} onGoTab={setTab} />}
      {tab === "calendar" && (
        <ContentCalendar onEdit={openEditor} refreshKey={refreshKey} onChanged={bump} />
      )}
      {tab === "queue" && <ApprovalQueue onEdit={openEditor} refreshKey={refreshKey} />}
      {tab === "history" && <PublishedHistory onEdit={openEditor} refreshKey={refreshKey} />}

      {editId && (
        <PostEditor
          postId={editId}
          onClose={closeEditor}
          onChanged={bump}
        />
      )}
    </div>
  );
}

// ─── Dashboard tab ───────────────────────────────────────────────────────────

function DashboardTab(props: {
  refreshKey: number;
  onEdit: (id: string) => void;
  onGoTab: (t: Tab) => void;
}) {
  const toast = useToast();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await api.get<{ posts: SocialPost[] }>("/api/social-posts");
        if (alive) setPosts(r.posts);
      } catch (e) {
        toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  const stats = useMemo(() => computeStats(posts), [posts]);
  const upcoming = useMemo(
    () =>
      posts
        .filter((p) => (p.status === "approved" || p.status === "scheduled") && p.scheduled_date)
        .sort((a, b) => (a.scheduled_date! < b.scheduled_date! ? -1 : 1))
        .slice(0, 6),
    [posts],
  );

  if (loading) return <Spinner center />;

  return (
    <div class="flex flex-col gap-md">
      <div class="social-stats">
        <button class="social-stat" onClick={() => props.onGoTab("queue")} style={{ textAlign: "left" }}>
          <div class="social-stat__value">{stats.pending}</div>
          <div class="social-stat__label">Pending approval</div>
        </button>
        <div class="social-stat">
          <div class="social-stat__value">{stats.scheduledThisWeek}</div>
          <div class="social-stat__label">Scheduled this week</div>
        </div>
        <div class="social-stat">
          <div class="social-stat__value">{stats.publishedThisMonth}</div>
          <div class="social-stat__label">Published this month</div>
        </div>
        <button class="social-stat" onClick={() => props.onGoTab("history")} style={{ textAlign: "left" }}>
          <div class="social-stat__value">{stats.failed}</div>
          <div class="social-stat__label">Failed / needs attention</div>
        </button>
      </div>

      <Card title="Upcoming posts">
        {upcoming.length === 0 ? (
          <div class="empty-state">
            <div class="empty-state__title">Nothing scheduled.</div>
            <Button variant="secondary" onClick={() => props.onGoTab("calendar")}>
              Generate a monthly schedule
            </Button>
          </div>
        ) : (
          <div class="flex flex-col gap-sm">
            {upcoming.map((p) => (
              <button
                key={p.id}
                class="social-cal__post"
                style={{ padding: "var(--space-sm)" }}
                onClick={() => props.onEdit(p.id)}
              >
                <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[p.post_type] }} />
                <span class="social-cal__post-label" style={{ flex: 1 }}>
                  {p.caption || formatStatus(p.post_type)}
                </span>
                <Badge status={p.status}>{formatStatus(p.status)}</Badge>
                <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                  {formatDateTime(p.scheduled_date)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function computeStats(posts: SocialPost[]) {
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let pending = 0;
  let scheduledThisWeek = 0;
  let publishedThisMonth = 0;
  let failed = 0;

  for (const p of posts) {
    if (p.status === "pending_approval") pending++;
    if (p.status === "failed") failed++;
    if ((p.status === "approved" || p.status === "scheduled") && p.scheduled_date) {
      const d = new Date(p.scheduled_date);
      if (d >= now && d <= weekFromNow) scheduledThisWeek++;
    }
    if (p.status === "published" && p.published_date) {
      const d = new Date(p.published_date);
      if (d >= monthStart) publishedThisMonth++;
    }
  }
  return { pending, scheduledThisWeek, publishedThisMonth, failed };
}
