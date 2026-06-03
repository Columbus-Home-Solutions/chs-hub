import type { KpiTile } from "./types";
import { go } from "../../lib/nav";

interface Props {
  tiles: KpiTile[];
  loading: boolean;
}

function SkeletonTile() {
  return <div class="kpi-tile kpi-tile--skeleton" aria-hidden="true" />;
}

export function KpiTiles({ tiles, loading }: Props) {
  if (loading) {
    return (
      <div class="kpi-strip">
        {[...Array(6)].map((_, i) => <SkeletonTile key={i} />)}
      </div>
    );
  }

  return (
    <div class="kpi-strip">
      {tiles.map((tile) => (
        <button
          key={tile.id}
          class="kpi-tile"
          onClick={() => go(tile.link)}
          title={`Go to ${tile.label}`}
        >
          <span class="kpi-tile__label">{tile.label}</span>
          <span class="kpi-tile__value">
            {tile.value}
            {tile.deltaDir === "up" && (
              <span class="kpi-tile__delta kpi-tile__delta--up"> ↑{tile.deltaPct}%</span>
            )}
            {tile.deltaDir === "down" && tile.id === "cash_this_week" && (
              <span class="kpi-tile__delta kpi-tile__delta--down"> ↓{tile.deltaPct}%</span>
            )}
          </span>
          <span
            class={`kpi-tile__subtitle${
              tile.id === "unpaid_invoices" && tile.deltaDir === "down"
                ? " kpi-tile__subtitle--alert"
                : ""
            }`}
          >
            {tile.subtitle}
          </span>
        </button>
      ))}
    </div>
  );
}
