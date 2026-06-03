import { useEffect, useMemo, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";
import { SOCIAL_POST_TYPES, SOCIAL_TYPE_COLORS, type SocialPost } from "../../types";

interface Props {
  onEdit: (id: string) => void;
  refreshKey: number;
  onChanged: () => void;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Content calendar (spec §5.2): month grid, colour-coded by post type, with
 *  an owner-only "Generate monthly schedule" action. */
export function ContentCalendar({ onEdit, refreshKey, onChanged }: Props) {
  const toast = useToast();
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const from = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}T23:59:59`;
      const r = await api.get<{ posts: SocialPost[] }>(
        `/api/social-posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
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
  }, [month, year, refreshKey]);

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api.post<{ posts_created: number; skipped_jobs: string[] }>(
        "/api/content-schedules/generate",
        { month, year },
      );
      toast.push(
        "success",
        `Generated ${r.posts_created} drafts${r.skipped_jobs?.length ? ` · ${r.skipped_jobs.length} job(s) skipped` : ""}.`,
      );
      onChanged();
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const prev = () => {
    if (month === 1) {
      setMonth(12);
      setYear((y) => y - 1);
    } else setMonth((m) => m - 1);
  };
  const next = () => {
    if (month === 12) {
      setMonth(1);
      setYear((y) => y + 1);
    } else setMonth((m) => m + 1);
  };

  const byDay = useMemo(() => {
    const map = new Map<number, SocialPost[]>();
    for (const p of posts) {
      if (!p.scheduled_date) continue;
      const d = new Date(p.scheduled_date);
      if (isNaN(d.getTime())) continue;
      const day = d.getDate();
      const arr = map.get(day) ?? [];
      arr.push(p);
      map.set(day, arr);
    }
    return map;
  }, [posts]);

  const firstDow = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <Card>
      <div class="flex justify-between items-center mb-md flex-wrap gap-md">
        <div class="flex gap-sm items-center">
          <Button size="sm" variant="tertiary" onClick={prev}>
            ‹
          </Button>
          <strong>
            {MONTHS[month - 1]} {year}
          </strong>
          <Button size="sm" variant="tertiary" onClick={next}>
            ›
          </Button>
        </div>
        <Button variant="primary" onClick={generate} disabled={generating}>
          {generating ? "Generating…" : "✨ Generate monthly schedule"}
        </Button>
      </div>

      {/* Legend */}
      <div class="flex gap-md flex-wrap mb-md">
        {SOCIAL_POST_TYPES.map((t) => (
          <span class="flex gap-sm items-center" style={{ fontSize: "var(--text-xs)" }}>
            <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[t.value] }} />
            {t.label}
          </span>
        ))}
      </div>

      {loading ? (
        <Spinner center />
      ) : (
        <>
          <div class="social-cal__head">
            {DOW.map((d) => (
              <div class="social-cal__dow">{d}</div>
            ))}
          </div>
          <div class="social-cal__grid">
            {cells.map((day, i) =>
              day == null ? (
                <div key={`e${i}`} class="social-cal__cell social-cal__cell--empty" />
              ) : (
                <div key={day} class="social-cal__cell">
                  <div class="social-cal__daynum">{day}</div>
                  {(byDay.get(day) ?? []).map((p) => (
                    <button
                      key={p.id}
                      class="social-cal__post"
                      title={`${formatStatus(p.post_type)} — ${formatStatus(p.status)}`}
                      onClick={() => onEdit(p.id)}
                    >
                      <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[p.post_type] }} />
                      <span class="social-cal__post-label">{p.caption || formatStatus(p.post_type)}</span>
                    </button>
                  ))}
                </div>
              ),
            )}
          </div>
        </>
      )}
    </Card>
  );
}
