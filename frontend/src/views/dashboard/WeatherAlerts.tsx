import { route } from "preact-router";
import type { ScheduleAlert, WeatherDay } from "../../store/weather";
import { weatherEmoji } from "../../store/weather";

interface Props {
  scheduleAlerts: ScheduleAlert[];
  forecast: WeatherDay[];
}

export function WeatherAlerts({ scheduleAlerts, forecast }: Props) {
  if (scheduleAlerts.length === 0) return null;

  const alertsByDate = new Map<string, ScheduleAlert[]>();
  for (const a of scheduleAlerts) {
    if (!alertsByDate.has(a.date)) alertsByDate.set(a.date, []);
    alertsByDate.get(a.date)!.push(a);
  }
  const alertDates = [...alertsByDate.keys()].sort();
  const forecastMap = new Map<string, WeatherDay>(forecast.map((d) => [d.date, d]));

  return (
    <div class="dash-card dash-card--warning">
      <div class="dash-card__header">
        <h2 class="dash-card__title">🌧 Weather Heads-Up</h2>
      </div>
      <div class="dash-card__body">
        {alertDates.map((date) => {
          const alerts = alertsByDate.get(date)!;
          const day = forecastMap.get(date);
          const label = day
            ? `${day.dayOfWeek} ${new Date(date + "T00:00:00Z").toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}`
            : date;
          const allJobIds = [...new Set(alerts.flatMap((a) => a.jobIds))];
          return (
            <div class="weather-row" key={date}>
              <div class="weather-row__date">{label}</div>
              <div class="weather-row__conditions">
                {alerts.map((a) => (
                  <span key={a.alertType} class="weather-row__condition">
                    {weatherEmoji(
                      a.alertType === "rain" ? "rain" : a.alertType === "freeze" ? "freeze" : "windy",
                    )}{" "}
                    {a.message}
                  </span>
                ))}
              </div>
              <div class="weather-row__jobs">
                {allJobIds.map((jobId) => (
                  <button
                    key={jobId}
                    class="weather-row__job-link"
                    onClick={() => route(`/jobs/${jobId}`)}
                  >
                    View job →
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
