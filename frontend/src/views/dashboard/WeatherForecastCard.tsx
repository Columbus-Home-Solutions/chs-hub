/**
 * Dashboard weather forecast card.
 *
 * Shows the full NWS forecast (up to 7 days, updated every 30 min) as a
 * horizontally scrollable strip. Collapsible. Click current conditions or
 * today's column for an hourly breakdown popup.
 */

import { useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { useWeather, weatherEmoji, type WeatherHour } from "../../store/weather";

function precipColor(pct: number): string {
  if (pct >= 70) return "var(--color-info)";
  if (pct >= 40) return "var(--color-warning)";
  return "var(--color-text-muted)";
}

function formatHourLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    hour12: true,
  });
}

function todayTitle(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function HourlyRow({ hour }: { hour: WeatherHour }) {
  return (
    <div class="weather-hourly-row">
      <span class="weather-hourly-row__time">{formatHourLabel(hour.time)}</span>
      <span class="weather-hourly-row__icon">{weatherEmoji(hour.icon)}</span>
      <span class="weather-hourly-row__temp">{hour.temperature}°</span>
      <span class="weather-hourly-row__cond">{hour.condition}</span>
      <span class="weather-hourly-row__meta">
        {hour.precipChance > 0 && (
          <span style={{ color: precipColor(hour.precipChance) }}>💧{hour.precipChance}%</span>
        )}
        {hour.windSpeed && <span>💨 {hour.windSpeed}</span>}
      </span>
    </div>
  );
}

export function WeatherForecastCard() {
  const weather = useWeather();
  const [collapsed, setCollapsed] = useState(false);
  const [hourlyOpen, setHourlyOpen] = useState(false);

  if (!weather || weather.forecast.length === 0) return null;

  const { current, forecast, hourlyToday = [] } = weather;
  const canShowHourly = hourlyToday.length > 0;

  const openHourly = (e: Event) => {
    e.stopPropagation();
    if (canShowHourly) setHourlyOpen(true);
  };

  return (
    <>
      <div class="dash-card">
        <div class="dash-card__header">
          <h2
            class={`dash-card__title${canShowHourly ? " weather-forecast-clickable" : ""}`}
            onClick={openHourly}
            title={canShowHourly ? "View hourly forecast" : undefined}
          >
            {current ? (
              <>
                {weatherEmoji(current.icon)}{" "}
                {current.temperature}°F — {current.condition}
              </>
            ) : (
              "🌤 Forecast"
            )}
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
            {current && (
              <span style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
                💨 {current.windSpeed}
              </span>
            )}
            <button
              type="button"
              class="weather-forecast-collapse"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand forecast" : "Collapse forecast"}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((v) => !v);
              }}
            >
              <span
                style={{
                  transition: "transform 0.2s",
                  display: "inline-block",
                  transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
                }}
              >
                ▾
              </span>
            </button>
          </div>
        </div>

        {!collapsed && (
          <div class="dash-card__body" style={{ padding: 0 }}>
            <div class="weather-forecast-strip">
              {forecast.map((day, i) => {
                const dateLabel = new Date(day.date + "T00:00:00Z").toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                });
                const isToday = i === 0;
                return (
                  <div
                    key={day.date}
                    class={`weather-forecast-day${isToday ? " weather-forecast-day--today" : ""}${isToday && canShowHourly ? " weather-forecast-clickable" : ""}`}
                    onClick={isToday && canShowHourly ? openHourly : undefined}
                    title={isToday && canShowHourly ? "View hourly forecast" : undefined}
                  >
                    <span class="weather-forecast-day__dow">{isToday ? "Today" : day.dayOfWeek}</span>
                    <span class="weather-forecast-day__date">{dateLabel}</span>
                    <span class="weather-forecast-day__emoji">{weatherEmoji(day.icon)}</span>
                    <span class="weather-forecast-day__high">{day.high}°</span>
                    <span class="weather-forecast-day__low">{day.low}°</span>
                    {day.precipChance > 0 && (
                      <span
                        class="weather-forecast-day__precip"
                        style={{ color: precipColor(day.precipChance), fontWeight: day.precipChance >= 40 ? 600 : 400 }}
                      >
                        💧{day.precipChance}%
                      </span>
                    )}
                    {day.windSpeed && <span class="weather-forecast-day__wind">{day.windSpeed}</span>}
                  </div>
                );
              })}
            </div>
            <div class="weather-forecast-footer">
              NWS · refreshes every 30 min
              {canShowHourly && (
                <>
                  {" · "}
                  <button type="button" class="link-btn" onClick={openHourly}>
                    Hourly today
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal open={hourlyOpen} title={`Hourly — ${todayTitle()}`} onClose={() => setHourlyOpen(false)}>
        <div class="weather-hourly-list">
          {hourlyToday.map((hour) => (
            <HourlyRow key={hour.time} hour={hour} />
          ))}
        </div>
      </Modal>
    </>
  );
}
