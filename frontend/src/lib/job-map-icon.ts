/**
 * Leaflet divIcon for job map pins — blue pushpin with hard-hat badge.
 * Plain construction emojis (🔨 🏗️ 🦺) disappear on busy OSM tiles; a pin
 * shape with high-contrast fill reads like a real map marker.
 */
export function makeJobMapIcon(L: typeof import("leaflet"), size: "sm" | "md" = "md") {
  const head = size === "sm" ? 22 : 28;
  const hat = size === "sm" ? 13 : 16;
  const pointH = size === "sm" ? 9 : 11;
  const pointW = size === "sm" ? 12 : 14;
  const width = head + 4;
  const height = head + pointH - 2;
  const anchorX = Math.round(width / 2);
  const anchorY = height;

  const hardHatSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${hat}" height="${hat}" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3C7 3 3.5 6.2 3 10.5h18C20.5 6.2 17 3 12 3Z" fill="#FACC15" stroke="#CA8A04" stroke-width="1.2"/>
      <ellipse cx="12" cy="11.5" rx="9.5" ry="2.2" fill="#EAB308" stroke="#CA8A04" stroke-width="0.8"/>
      <rect x="10.8" y="7.2" width="2.4" height="2.8" rx="0.4" fill="#CA8A04"/>
    </svg>
  `.trim();

  const html = `
    <div style="width:${width}px;height:${height}px;position:relative;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.45))">
      <div style="
        position:absolute;
        top:0;
        left:${Math.round((width - head) / 2)}px;
        width:${head}px;
        height:${head}px;
        border-radius:50%;
        background:linear-gradient(160deg,#3B82F6 0%,#1D4ED8 100%);
        border:2.5px solid #fff;
        display:flex;
        align-items:center;
        justify-content:center;
        box-sizing:border-box;
        z-index:1;
      ">
        ${hardHatSvg}
      </div>
      <div style="
        position:absolute;
        bottom:0;
        left:${Math.round((width - pointW) / 2)}px;
        width:0;
        height:0;
        border-left:${Math.round(pointW / 2)}px solid transparent;
        border-right:${Math.round(pointW / 2)}px solid transparent;
        border-top:${pointH}px solid #1D4ED8;
      "></div>
    </div>
  `.trim();

  return L.divIcon({
    className: "",
    html,
    iconSize: [width, height],
    iconAnchor: [anchorX, anchorY],
    popupAnchor: [0, -height + 4],
  });
}
