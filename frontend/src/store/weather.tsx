/**
 * Weather store — fetches GET /api/weather once on mount, re-fetches every
 * 30 minutes, and exposes data to TopNav, Dashboard, and the calendar views
 * via context. A NWS failure silently returns null; consumers must handle it.
 */

import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";

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

export interface WeatherCurrent {
  temperature: number;
  condition: string;
  icon: WeatherIcon;
  windSpeed: string;
  updatedAt: string;
}

export interface WeatherDay {
  date: string;       // YYYY-MM-DD
  dayOfWeek: string;  // "Thu"
  high: number;
  low: number;
  condition: string;
  icon: WeatherIcon;
  precipChance: number;
  windSpeed: string;
}

export interface ScheduleAlert {
  date: string;
  alertType: "rain" | "freeze" | "wind";
  severity: "warning" | "watch";
  message: string;
  jobCount: number;
  jobIds: string[];
}

export interface WeatherData {
  current: WeatherCurrent | null;
  forecast: WeatherDay[];
  scheduleAlerts: ScheduleAlert[];
}

const ICON_EMOJI: Record<WeatherIcon, string> = {
  sunny: "☀️",
  partly_cloudy: "⛅",
  cloudy: "☁️",
  rain: "🌧️",
  thunderstorm: "⛈️",
  snow: "🌨️",
  freeze: "🧊",
  windy: "💨",
  fog: "🌫️",
};

export function weatherEmoji(icon: WeatherIcon): string {
  return ICON_EMOJI[icon] ?? "🌡️";
}

const WeatherContext = createContext<WeatherData | null>(null);

const REFETCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function WeatherProvider({ children }: { children: ComponentChildren }) {
  const [data, setData] = useState<WeatherData | null>(null);

  const load = () => {
    fetch("/api/weather")
      .then((r) => (r.ok ? r.json() as Promise<WeatherData> : Promise.resolve(null)))
      .then((d) => setData(d ?? null))
      .catch(() => setData(null));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, REFETCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return <WeatherContext.Provider value={data}>{children}</WeatherContext.Provider>;
}

export function useWeather(): WeatherData | null {
  return useContext(WeatherContext);
}
