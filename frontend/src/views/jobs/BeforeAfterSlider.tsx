import { useRef, useState } from "preact/hooks";

/**
 * Before/after comparison slider (Sprint 18, deliverable B; §4.4).
 * A draggable divider reveals the "before" image over the "after". Pure
 * presentational — pairing itself is persisted server-side via /api/photos/pair.
 */
export function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
}: {
  beforeUrl: string;
  afterUrl: string;
}) {
  const [pos, setPos] = useState(50);
  const wrap = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const moveTo = (clientX: number) => {
    const el = wrap.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.max(0, Math.min(100, pct)));
  };

  return (
    <div
      ref={wrap}
      class="ba-slider"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        moveTo(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerLeave={() => (dragging.current = false)}
    >
      <img class="ba-slider__img" src={afterUrl} alt="After" draggable={false} />
      <img
        class="ba-slider__img ba-slider__img--before"
        src={beforeUrl}
        alt="Before"
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <div class="ba-slider__divider" style={{ left: `${pos}%` }}>
        <span class="ba-slider__handle">⇆</span>
      </div>
      <span class="ba-slider__label ba-slider__label--before">Before</span>
      <span class="ba-slider__label ba-slider__label--after">After</span>
    </div>
  );
}
