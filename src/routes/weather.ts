/**
 * Weather API — GET /api/weather
 *
 * Data source: National Weather Service (free, no key, US-only). All NWS calls
 * happen server-side; the browser never contacts NWS directly.
 *
 * Two-step NWS resolution:
 *   1. company_address → lat/lon via US Census Geocoder (24 h cache)
 *   2. lat/lon → NWS gridId/gridX/gridY  (24 h cache, bundled with step 1)
 *   3. gridpoint/forecast/hourly → current conditions (30 min cache)
 *   4. gridpoint/forecast        → 7-day daily forecast (30 min cache)
 *
 * scheduleAlerts are computed fresh on every call (D1 query is cheap; schedule
 * changes must reflect immediately). An alert is only included when a day with
 * bad weather also has jobs in status 'scheduled' or 'in_progress'.
 *
 * NWS User-Agent is mandatory — omitting it returns 403.
 *
 * Role: ALL authenticated users.
 */

import type { Env } from "../env.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WeatherIcon =
  | "sunny"
  | "partly_cloudy"
  | "cloudy"
  | "rain"
  | "thunderstorm"
  | "snow"
  | "freeze"
  | "windy"
  | "fog";

interface GridPoint {
  lat: number;
  lon: number;
  gridId: string;
  gridX: number;
  gridY: number;
}

interface ForecastDay {
  date: string;          // YYYY-MM-DD
  dayOfWeek: string;     // "Thu"
  high: number;
  low: number;
  condition: string;
  icon: WeatherIcon;
  precipChance: number;  // 0-100
  windSpeed: string;
}

interface WeatherHour {
  time: string;          // ISO startTime from NWS
  temperature: number;
  condition: string;
  icon: WeatherIcon;
  precipChance: number;
  windSpeed: string;
}

interface ScheduleAlert {
  date: string;
  alertType: "rain" | "freeze" | "wind";
  severity: "warning" | "watch";
  message: string;
  jobCount: number;
  jobIds: string[];
}

interface WeatherResponse {
  current: {
    temperature: number;
    condition: string;
    icon: WeatherIcon;
    windSpeed: string;
    updatedAt: string;
  } | null;
  forecast: Array<ForecastDay>;
  /** Hourly periods for the current calendar day (NWS local date). */
  hourlyToday: Array<WeatherHour>;
  scheduleAlerts: ScheduleAlert[];
}

// ─── NWS requirement ─────────────────────────────────────────────────────────

const NWS_UA = "CHS-Hub/1.0 (columbus-home-solutions; contact@homesolutionsar.com)";

// ─── In-memory cache (resets on cold start — fine for weather data) ──────────

const _cache = new Map<string, { value: unknown; expiresAt: number }>();
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function cacheGet<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet(key: string, value: unknown, ttlMs: number): void {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ─── Icon mapping ─────────────────────────────────────────────────────────────

function toIcon(shortForecast: string): WeatherIcon {
  const s = shortForecast.toLowerCase();
  if (s.includes("thunder") || s.includes("storm")) return "thunderstorm";
  if (s.includes("snow") || s.includes("flurr") || s.includes("blizzard")) return "snow";
  if (s.includes("freez") || s.includes("frost") || s.includes("ice") || s.includes("sleet")) return "freeze";
  if (s.includes("rain") || s.includes("shower") || s.includes("drizzle")) return "rain";
  if (s.includes("fog") || s.includes("mist") || s.includes("haze")) return "fog";
  if (s.includes("wind") || s.includes("breezy") || s.includes("blustery") || s.includes("gusty")) return "windy";
  if (s.includes("overcast") || (s.includes("cloud") && s.includes("mostly"))) return "cloudy";
  if (s.includes("partly") || s.includes("cloud")) return "partly_cloudy";
  if (s.includes("sun") || s.includes("clear")) return "sunny";
  return "partly_cloudy";
}

function parseWindMph(windSpeed: string): number {
  const m = /(\d+)\s*(?:to\s*(\d+))?/.exec(windSpeed);
  if (!m) return 0;
  // Use the upper bound of a range, or single value.
  return parseInt(m[2] ?? m[1], 10);
}

// ─── Geocode + NWS grid-point (24 h cache) ────────────────────────────────────

async function resolveGridPoint(address: string): Promise<GridPoint | null> {
  const key = `gp:${address}`;
  const cached = cacheGet<GridPoint>(key);
  if (cached) return cached;

  // Step 1 — US Census Geocoder (no API key required)
  const geoUrl =
    `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` +
    `?address=${encodeURIComponent(address)}&benchmark=2020&format=json`;
  let geoResp: Response;
  try {
    geoResp = await fetch(geoUrl);
  } catch {
    return null;
  }
  if (!geoResp.ok) return null;

  const geoData = (await geoResp.json()) as {
    result?: { addressMatches?: Array<{ coordinates?: { x: number; y: number } }> };
  };
  const coords = geoData?.result?.addressMatches?.[0]?.coordinates;
  if (!coords) return null;

  const lat = coords.y;
  const lon = coords.x;

  // Step 2 — NWS points endpoint (User-Agent mandatory)
  let ptResp: Response;
  try {
    ptResp = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { "User-Agent": NWS_UA, Accept: "application/geo+json" },
    });
  } catch {
    return null;
  }
  if (!ptResp.ok) return null;

  const ptData = (await ptResp.json()) as {
    properties?: { gridId: string; gridX: number; gridY: number };
  };
  const props = ptData?.properties;
  if (!props) return null;

  const gp: GridPoint = { lat, lon, gridId: props.gridId, gridX: props.gridX, gridY: props.gridY };
  cacheSet(key, gp, TWENTY_FOUR_HOURS_MS);
  return gp;
}

// ─── NWS forecast helper ──────────────────────────────────────────────────────

interface NwsPeriod {
  name: string;
  startTime: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  shortForecast: string;
  isDaytime: boolean;
  probabilityOfPrecipitation?: { value: number | null };
}

async function fetchNwsForecast(
  gp: GridPoint,
  variant: "daily" | "hourly",
): Promise<NwsPeriod[] | null> {
  const cacheKey = `nws:${variant}:${gp.gridId}:${gp.gridX}:${gp.gridY}`;
  const cached = cacheGet<NwsPeriod[]>(cacheKey);
  if (cached) return cached;

  const path = variant === "hourly" ? "/forecast/hourly" : "/forecast";
  const url = `https://api.weather.gov/gridpoints/${gp.gridId}/${gp.gridX},${gp.gridY}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": NWS_UA, Accept: "application/geo+json" },
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const data = (await resp.json()) as { properties?: { periods?: NwsPeriod[] } };
  const periods = data?.properties?.periods ?? null;
  if (!periods) return null;

  cacheSet(cacheKey, periods, THIRTY_MINUTES_MS);
  return periods;
}

// ─── Build the 7-day forecast array ──────────────────────────────────────────

function buildForecast(periods: NwsPeriod[]): ForecastDay[] {
  // NWS returns 14 periods for a full 7-day daily forecast. Guard against a
  // malformed or empty response.
  if (periods.length < 2) return [];

  // Group by calendar date rather than by index. When the API is queried at
  // night the first period is "Tonight" (nighttime), which would leave only
  // 6 daytime entries and produce a 6-day strip. Grouping by date handles
  // both the daytime-first and nighttime-first cases correctly.
  const byDate = new Map<string, { day: NwsPeriod | null; night: NwsPeriod | null }>();
  for (const p of periods) {
    const date = p.startTime.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { day: null, night: null });
    const entry = byDate.get(date)!;
    if (p.isDaytime) entry.day = p;
    else entry.night = p;
  }

  return [...byDate.keys()]
    .sort()
    .slice(0, 7) // cap at 7 days regardless of API response size
    .map((date) => {
      const { day, night } = byDate.get(date)!;
      const ref = day ?? night!;
      const dayOfWeek = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: "UTC",
      });
      const precipChance =
        (day?.probabilityOfPrecipitation?.value ?? night?.probabilityOfPrecipitation?.value ?? 0) ?? 0;
      return {
        date,
        dayOfWeek,
        high: day?.temperature ?? ref.temperature,
        low: night?.temperature ?? ref.temperature,
        condition: ref.shortForecast,
        icon: toIcon(ref.shortForecast),
        precipChance,
        windSpeed: ref.windSpeed,
      };
    });
}

/** Hourly NWS periods for the same local calendar day as the first hourly period. */
function buildHourlyToday(periods: NwsPeriod[]): WeatherHour[] {
  if (!periods.length) return [];
  const todayKey = periods[0].startTime.slice(0, 10);
  return periods
    .filter((p) => p.startTime.slice(0, 10) === todayKey)
    .map((p) => ({
      time: p.startTime,
      temperature: p.temperature,
      condition: p.shortForecast,
      icon: toIcon(p.shortForecast),
      precipChance: p.probabilityOfPrecipitation?.value ?? 0,
      windSpeed: p.windSpeed,
    }));
}

// ─── Alert threshold checks ───────────────────────────────────────────────────

// Thresholds: rain ≥ 40%, freeze ≤ 35°F high, wind ≥ 25 mph.
function detectAlertTypes(
  day: ForecastDay,
): Array<{ alertType: "rain" | "freeze" | "wind"; severity: "warning" | "watch"; message: string }> {
  const alerts: Array<{ alertType: "rain" | "freeze" | "wind"; severity: "warning" | "watch"; message: string }> = [];
  if (day.precipChance >= 40) {
    alerts.push({
      alertType: "rain",
      severity: day.precipChance >= 70 ? "warning" : "watch",
      message: `Rain forecast (${day.precipChance}%)`,
    });
  }
  if (day.high <= 35 || day.low <= 32) {
    alerts.push({
      alertType: "freeze",
      severity: day.low <= 28 ? "warning" : "watch",
      message: `Freeze warning (${day.high}°F high / ${day.low}°F low)`,
    });
  }
  const windMph = parseWindMph(day.windSpeed);
  if (windMph >= 25) {
    alerts.push({
      alertType: "wind",
      severity: windMph >= 40 ? "warning" : "watch",
      message: `High wind (${windMph} mph)`,
    });
  }
  return alerts;
}

// ─── Schedule cross-reference ─────────────────────────────────────────────────

async function getScheduledJobs(
  env: Env,
  date: string,
): Promise<{ jobId: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT se.job_id
     FROM schedule_entries se
     JOIN jobs j ON j.id = se.job_id
     WHERE se.scheduled_date = ?
       AND se.status IN ('scheduled', 'in_progress')`,
  )
    .bind(date)
    .all<{ job_id: string }>();
  return (rows.results ?? []).map((r) => ({ jobId: r.job_id }));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleWeather(env: Env): Promise<WeatherResponse> {
  // Resolve company address.
  const addrRow = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = 'company_address'",
  ).first<{ value: string }>();
  const address = addrRow?.value ?? "";

  if (!address) {
    return { current: null, forecast: [], hourlyToday: [], scheduleAlerts: [] };
  }

  // Resolve grid-point (24 h cache).
  const gp = await resolveGridPoint(address);
  if (!gp) {
    return { current: null, forecast: [], hourlyToday: [], scheduleAlerts: [] };
  }

  // Fetch hourly + daily in parallel (both 30 min cached).
  const [hourlyPeriods, dailyPeriods] = await Promise.all([
    fetchNwsForecast(gp, "hourly"),
    fetchNwsForecast(gp, "daily"),
  ]);

  // Current conditions: first period of the hourly forecast.
  let current: WeatherResponse["current"] = null;
  if (hourlyPeriods && hourlyPeriods.length > 0) {
    const now = hourlyPeriods[0];
    current = {
      temperature: now.temperature,
      condition: now.shortForecast,
      icon: toIcon(now.shortForecast),
      windSpeed: now.windSpeed,
      updatedAt: new Date().toISOString(),
    };
  }

  // 7-day forecast + today's hourly strip.
  const forecast = dailyPeriods ? buildForecast(dailyPeriods) : [];
  const hourlyToday = hourlyPeriods ? buildHourlyToday(hourlyPeriods) : [];

  // Schedule cross-reference — computed fresh each call.
  const scheduleAlerts: ScheduleAlert[] = [];
  for (const day of forecast) {
    const alertTypes = detectAlertTypes(day);
    if (alertTypes.length === 0) continue;

    const scheduledJobs = await getScheduledJobs(env, day.date);
    if (scheduledJobs.length === 0) continue; // no jobs scheduled → no alert

    for (const at of alertTypes) {
      scheduleAlerts.push({
        date: day.date,
        alertType: at.alertType,
        severity: at.severity,
        message: `${at.message} — ${scheduledJobs.length} job${scheduledJobs.length !== 1 ? "s" : ""} scheduled`,
        jobCount: scheduledJobs.length,
        jobIds: scheduledJobs.map((j) => j.jobId),
      });
    }
  }

  return { current, forecast, hourlyToday, scheduleAlerts };
}
