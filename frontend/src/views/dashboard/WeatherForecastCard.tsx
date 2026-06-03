/**
 * Dashboard weather forecast card.
 *
 * Shows the full NWS forecast (up to 7 days, updated every 30 min) as a
 * horizontally scrollable strip. Collapsible. Reads from the existing
 * WeatherProvider context — no extra fetch needed.
 *
 * Deliberately separate from WeatherAlerts so the alert logic is untouched.
 */

import { useState } from "preact/hooks";
import { useWeather, weatherEmoji } from "../../store/weather";

function precipColor(pct: number): string {
  if (pct >= 70) return "var(--color-info)";
  if (pct >= 40) return "var(--color-warning)";
  return "var(--color-text-muted)";
}

export function WeatherForecastCard() {
  const weather = useWeather();
  const [collapsed, setCollapsed] = useState(false);

  // Nothing to show if weather isn't available or forecast is empty.
  if (!weather || weather.forecast.length === 0) return null;

  const { current, forecast } = weather;

  return (
    <div class="dash-card">
      <div
        class="dash-card__header"
        style={{ cursor: "pointer" }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <h2 class="dash-card__title">
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
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--color-text-muted)",
              transition: "transform 0.2s",
              display: "inline-block",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
            }}
          >
            ▾
          </span>
        </div>
      </div>

      {!collapsed && (
        <div class="dash-card__body" style={{ padding: 0 }}>
          <div
            style={{
              display: "flex",
              overflowX: "auto",
              gap: 0,
              WebkitOverflowScrolling: "touch",
              scrollbarWidth: "none",
            }}
          >
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
                  style={{
                    flex: "0 0 auto",
                    width: "80px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "2px",
                    padding: "var(--space-sm) var(--space-xs)",
                    borderRight: "1px solid var(--color-border)",
                    background: isToday ? "var(--color-brand-subtle)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-xs, 11px)",
                      fontWeight: isToday ? 700 : 500,
                      color: isToday ? "var(--color-brand)" : "var(--color-text-secondary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {isToday ? "Today" : day.dayOfWeek}
                  </span>
                  <span style={{ fontSize: "var(--text-xs, 11px)", color: "var(--color-text-muted)" }}>
                    {dateLabel}
                  </span>
                  <span style={{ fontSize: "22px", lineHeight: 1.2 }}>
                    {weatherEmoji(day.icon)}
                  </span>
                  <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--color-text-primary)" }}>
                    {day.high}°
                  </span>
                  <span style={{ fontSize: "var(--text-xs, 11px)", color: "var(--color-text-muted)" }}>
                    {day.low}°
                  </span>
                  {day.precipChance > 0 && (
                    <span
                      style={{
                        fontSize: "var(--text-xs, 11px)",
                        color: precipColor(day.precipChance),
                        fontWeight: day.precipChance >= 40 ? 600 : 400,
                      }}
                    >
                      💧{day.precipChance}%
                    </span>
                  )}
                  {day.windSpeed && (
                    <span
                      style={{
                        fontSize: "10px",
                        color: "var(--color-text-muted)",
                        textAlign: "center",
                        lineHeight: 1.2,
                      }}
                    >
                      {day.windSpeed}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{
            padding: "var(--space-xs) var(--space-sm)",
            fontSize: "10px",
            color: "var(--color-text-muted)",
            borderTop: "1px solid var(--color-border)",
            textAlign: "right",
          }}>
            NWS · refreshes every 30 min
          </div>
        </div>
      )}
    </div>
  );
}
