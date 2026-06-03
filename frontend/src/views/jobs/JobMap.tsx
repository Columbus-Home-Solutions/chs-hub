/**
 * Job Map view — /app/jobs/map
 *
 * Renders non-closed jobs as blue hard-hat pushpins on an
 * OpenStreetMap tile layer. Geocoding happens server-side via the Census
 * Geocoder (GET /api/jobs/map). Clicking a popup link navigates to the job
 * detail page.
 */

import type { RoutableProps } from "preact-router";
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

interface MapResponse {
  pins: MapPin[];
  skipped: string[];
}

function statusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// North Little Rock, AR — default map center.
const DEFAULT_CENTER: [number, number] = [34.7695, -92.2671];
const DEFAULT_ZOOM = 11;

export function JobMap(_props: RoutableProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [skippedDismissed, setSkippedDismissed] = useState(false);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    let cancelled = false;

    async function initMap() {
      const L = (await import("leaflet")).default;
      await import("leaflet/dist/leaflet.css");

      if (cancelled || !mapContainerRef.current) return;

      // Only init once.
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(mapContainerRef.current).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
      mapRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
        maxZoom: 19,
      }).addTo(map);

      let data: MapResponse;
      try {
        const res = await fetch("/api/jobs/map");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = (await res.json()) as MapResponse;
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "Failed to load map data");
        setLoading(false);
        return;
      }

      if (cancelled) return;

      setSkippedCount(data.skipped.length);
      setLoading(false);

      for (const pin of data.pins) {
        const icon = makeJobMapIcon(L);
        const popupHtml = `
          <div style="min-width:160px;line-height:1.4">
            <strong>Job #${pin.job_number ?? "—"}</strong><br>
            ${pin.title ?? ""}<br>
            <em style="font-size:0.85em">${pin.client_name ?? ""}</em><br>
            <span style="font-size:0.8em;opacity:0.7">${statusLabel(pin.status)}</span><br>
            <a href="/app/jobs/${pin.job_id}" style="font-size:0.85em;color:#3B82F6">Open Job →</a>
          </div>
        `;
        L.marker([pin.lat, pin.lon], { icon })
          .bindPopup(popupHtml)
          .addTo(map);
      }

      // If we have pins, fit the map to show them all.
      if (data.pins.length > 0) {
        const latlngs = data.pins.map((p) => [p.lat, p.lon] as [number, number]);
        map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 14 });
      }
    }

    void initMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div class="view-header">
        <div>
          <h1 class="view-title">Jobs Map</h1>
        </div>
        <button class="btn btn--secondary btn--sm" onClick={() => go("/jobs")}>
          ← Pipeline View
        </button>
      </div>

      {skippedCount > 0 && !skippedDismissed && (
        <div
          class="banner banner--warning"
          style={{ marginBottom: "var(--space-sm)", display: "flex", alignItems: "center", gap: "var(--space-sm)" }}
        >
          <span>
            {skippedCount} job{skippedCount !== 1 ? "s" : ""} could not be geocoded and are not shown.
          </span>
          <button class="link-btn" onClick={() => setSkippedDismissed(true)}>
            Dismiss
          </button>
        </div>
      )}

      {loading && (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000,
            background: "var(--color-surface-2)",
            padding: "var(--space-md)",
            borderRadius: "var(--radius-md)",
          }}
        >
          Loading map…
        </div>
      )}

      {error && (
        <div class="banner banner--error" style={{ marginBottom: "var(--space-sm)" }}>
          Failed to load map data: {error}
        </div>
      )}

      <div
        ref={mapContainerRef}
        id="job-map"
        style={{
          flex: 1,
          minHeight: "500px",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
