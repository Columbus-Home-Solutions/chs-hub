import { go } from "../../lib/nav";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";

interface Meeting {
  id: string;
  title: string;
  start_time: string;
  meet_link: string | null;
}

function formatMeetingWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} at ${time}`;
}

export function UpcomingMeetings() {
  const { data, loading, error } = useApi<{ connected: boolean; meetings: Meeting[] }>(
    "/api/dashboard/meetings",
  );

  if (loading) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Upcoming Meetings</h2>
        </div>
        <div class="dash-card__body">
          {[...Array(2)].map((_, i) => (
            <div key={i} class="schedule-row schedule-row--skeleton" aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card">
        <div class="dash-card__header"><h2 class="dash-card__title">Upcoming Meetings</h2></div>
        <div class="dash-card__body dash-card__body--error">Unable to load meetings.</div>
      </div>
    );
  }

  const connected = data?.connected ?? false;
  const meetings = data?.meetings ?? [];

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">Upcoming Meetings</h2>
      </div>
      <div class="dash-card__body">
        {!connected ? (
          <div class="schedule__empty">
            Connect Google Calendar in{" "}
            <button class="link-btn" onClick={() => go("/settings/integrations")}>
              Settings → Integrations
            </button>{" "}
            to see your meetings here.
          </div>
        ) : meetings.length === 0 ? (
          <div class="schedule__empty">
            No upcoming meetings — your Google Calendar is synced every 15 minutes.
          </div>
        ) : (
          meetings.map((m) => (
            <div key={m.id} class="schedule-row schedule-row--static">
              <div class="schedule-row__info" style={{ flex: 1 }}>
                <span class="schedule-row__label">{m.title}</span>
                <span class="schedule-row__desc">{formatMeetingWhen(m.start_time)}</span>
              </div>
              {m.meet_link && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(m.meet_link!, "_blank", "noopener,noreferrer")}
                >
                  Join
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
