/**
 * Dashboard jobs-map widget.
 *
 * Compact Leaflet map showing all non-closed jobs as hard-hat pushpins.
 * Reuses GET /api/jobs/map (same endpoint as the full JobMap view).
 * "Open Map →" navigates to /app/jobs/map for the full interactive view.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { go } from "../../lib/nav";
import { makeJobMapIcon } from "../../lib/job-map-icon";
import type { Map as LeafletMap } from "leaflet";

interface MapPin {
  job_id: string;
  job_number: number | null;
  title: string | null;
  status: string;
  client_name: string | null;
  address: string;
  lat: number;
  lon: number;
}

function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const DEFAULT_CENTER: [number, number] = [34.7695, -92.2671];
const DEFAULT_ZOOM = 10;

export function JobsMapWidget() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [pinCount, setPinCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    async function init() {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");
      if (cancelled || !containerRef.current) return;

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        dragging: true,
        doubleClickZoom: true,
      }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(map);

      let pins: MapPin[] = [];
      try {
        const res = await fetch("/api/jobs/map");
        if (!res.ok) throw new Error("fetch failed");
        const data = (await res.json()) as { pins: MapPin[] };
        pins = data.pins ?? [];
      } catch {
        if (!cancelled) setError(true);
        setLoading(false);
        return;
      }

      if (cancelled) return;
      setPinCount(pins.length);
      setLoading(false);

      for (const pin of pins) {
        const icon = makeJobMapIcon(L, "sm");
        const popup = `<div style="min-width:140px;line-height:1.4;font-size:13px">
          <strong>Job #${pin.job_number ?? "—"}</strong><br>
          ${pin.title ?? ""}<br>
          <em style="font-size:0.85em">${pin.client_name ?? ""}</em><br>
          <span style="font-size:0.8em;opacity:0.7">${statusLabel(pin.status)}</span><br>
          <a href="/app/jobs/${pin.job_id}" style="font-size:0.85em;color:#3B82F6">Open Job →</a>
        </div>`;
        L.marker([pin.lat, pin.lon], { icon }).bindPopup(popup).addTo(map);
      }

      if (pins.length > 0) {
        const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lon] as [number, number]));
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
      }
    }

    void init();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div class="dash-card">
      <div class="dash-card__header">
        <h2 class="dash-card__title">
          Jobs Map
          {pinCount !== null && (
            <span class="dash-card__badge" style={{ marginLeft: "var(--space-xs)" }}>
              {pinCount}
            </span>
          )}
        </h2>
        <button class="link-btn" onClick={() => go("/jobs/map")}>
          Open Map →
        </button>
      </div>
      <div style={{ position: "relative" }}>
        {loading && (
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-surface-1)",
            zIndex: 10,
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
            borderRadius: "0 0 var(--radius-md) var(--radius-md)",
            height: "260px",
          }}>
            Loading map…
          </div>
        )}
        {error && !loading && (
          <div style={{
            height: "260px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-sm)",
          }}>
            Map unavailable
          </div>
        )}
        <div
          ref={containerRef}
          style={{
            height: "260px",
            borderRadius: "0 0 var(--radius-md) var(--radius-md)",
            overflow: "hidden",
          }}
        />
      </div>
    </div>
  );
}
