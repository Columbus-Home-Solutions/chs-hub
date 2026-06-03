import { useEffect, useRef, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { api, ApiError } from "../../api";
import type { useToast } from "../../store/toast";
import type { AnnotationData, AnnotationShape } from "../../lib/annotation";
import { emptyAnnotation } from "../../lib/annotation";
import { nativeHaptic } from "../../lib/native";

type Tool = "pen" | "rect" | "ellipse" | "arrow" | "text" | "crop";

const COLORS = ["#c8102e", "#ffd400", "#00aa55", "#1e6fff", "#ffffff", "#1d2733"];
const WIDTHS = [2, 4, 8, 14];

/**
 * Non-destructive photo markup editor (Sprint 18, deliverable A).
 *
 * Draws on an overlay <canvas> sized to the displayed image; serializes to the
 * shared AnnotationData contract in NATURAL image pixels so the saved overlay
 * round-trips losslessly and renders identically in the HTML photo report. The
 * stored original is never modified — save only writes annotation_data.
 */
export function PhotoAnnotator({
  photoId,
  originalUrl,
  onClose,
  onSaved,
  toast,
}: {
  photoId: string;
  originalUrl: string;
  onClose: () => void;
  onSaved: () => void;
  toast: ReturnType<typeof useToast>;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [shapes, setShapes] = useState<AnnotationShape[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [busy, setBusy] = useState(false);
  const draft = useRef<AnnotationShape | null>(null);
  const drawing = useRef(false);

  // Load any saved overlay.
  useEffect(() => {
    api
      .get<{ annotation_data: AnnotationData | null }>(`/api/photos/${photoId}/annotation`)
      .then((r) => {
        if (r.annotation_data?.shapes) setShapes(r.annotation_data.shapes);
      })
      .catch(() => undefined);
  }, [photoId]);

  // Scale factor: natural px ↔ displayed px.
  function scale(): { sx: number; sy: number } {
    const img = imgRef.current;
    if (!img || !natural) return { sx: 1, sy: 1 };
    return { sx: natural.w / img.clientWidth, sy: natural.h / img.clientHeight };
  }

  function toImage(e: PointerEvent): [number, number] {
    const img = imgRef.current!;
    const rect = img.getBoundingClientRect();
    const { sx, sy } = scale();
    const x = (e.clientX - rect.left) * sx;
    const y = (e.clientY - rect.top) * sy;
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  }

  function syncCanvasSize() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    redraw();
  }

  function redraw() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !natural) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dx = canvas.width / natural.w;
    const dy = canvas.height / natural.h;
    const all = draft.current ? [...shapes, draft.current] : shapes;
    for (const s of all) drawShape(ctx, s, dx, dy);
  }

  function drawShape(ctx: CanvasRenderingContext2D, s: AnnotationShape, dx: number, dy: number) {
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (s.type !== "crop" && s.type !== "text") {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width * ((dx + dy) / 2);
    }
    switch (s.type) {
      case "pen":
        ctx.beginPath();
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * dx, p[1] * dy) : ctx.lineTo(p[0] * dx, p[1] * dy)));
        ctx.stroke();
        break;
      case "rect":
        ctx.strokeRect(s.x * dx, s.y * dy, s.w * dx, s.h * dy);
        break;
      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(s.cx * dx, s.cy * dy, Math.abs(s.rx) * dx, Math.abs(s.ry) * dy, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "arrow": {
        const x1 = s.x1 * dx, y1 = s.y1 * dy, x2 = s.x2 * dx, y2 = s.y2 * dy;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = 8 + s.width * ((dx + dy) / 2);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
        break;
      }
      case "text":
        ctx.fillStyle = s.color;
        ctx.font = `700 ${s.size * dy}px -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
        ctx.lineWidth = Math.max(1, (s.size * dy) / 12);
        ctx.strokeStyle = "#00000088";
        ctx.strokeText(s.text, s.x * dx, s.y * dy);
        ctx.fillText(s.text, s.x * dx, s.y * dy);
        break;
      case "crop":
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.45)";
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.clearRect(s.x * dx, s.y * dy, s.w * dx, s.h * dy);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(s.x * dx, s.y * dy, s.w * dx, s.h * dy);
        ctx.restore();
        break;
    }
  }

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, natural]);

  useEffect(() => {
    const onResize = () => syncCanvasSize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural]);

  const onDown = (e: PointerEvent) => {
    if (!natural) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const [x, y] = toImage(e);
    drawing.current = true;
    if (tool === "pen") draft.current = { type: "pen", points: [[x, y]], color, width };
    else if (tool === "rect") draft.current = { type: "rect", x, y, w: 0, h: 0, color, width };
    else if (tool === "ellipse") draft.current = { type: "ellipse", cx: x, cy: y, rx: 0, ry: 0, color, width };
    else if (tool === "arrow") draft.current = { type: "arrow", x1: x, y1: y, x2: x, y2: y, color, width };
    else if (tool === "crop") draft.current = { type: "crop", x, y, w: 0, h: 0 };
    else if (tool === "text") {
      drawing.current = false;
      const text = window.prompt("Label text:");
      if (text && text.trim()) {
        setShapes((s) => [...s, { type: "text", x, y, text: text.trim(), color, size: Math.max(18, width * 6) }]);
      }
    }
  };

  const onMove = (e: PointerEvent) => {
    if (!drawing.current || !draft.current) return;
    const [x, y] = toImage(e);
    const d = draft.current;
    if (d.type === "pen") d.points.push([x, y]);
    else if (d.type === "rect" || d.type === "crop") {
      d.w = x - d.x;
      d.h = y - d.y;
    } else if (d.type === "ellipse") {
      d.rx = Math.abs(x - d.cx);
      d.ry = Math.abs(y - d.cy);
    } else if (d.type === "arrow") {
      d.x2 = x;
      d.y2 = y;
    }
    redraw();
  };

  const onUp = () => {
    if (!drawing.current || !draft.current) {
      drawing.current = false;
      return;
    }
    drawing.current = false;
    const d = draft.current;
    draft.current = null;
    // Normalize negative rect/crop, drop degenerate shapes.
    if (d.type === "rect" || d.type === "crop") {
      if (d.w < 0) { d.x += d.w; d.w = -d.w; }
      if (d.h < 0) { d.y += d.h; d.h = -d.h; }
      if (d.w < 4 || d.h < 4) { redraw(); return; }
      // Only one crop at a time — replace any existing crop.
      if (d.type === "crop") setShapes((s) => [...s.filter((x) => x.type !== "crop"), d]);
      else setShapes((s) => [...s, d]);
    } else if (d.type === "pen" && d.points.length < 2) {
      redraw();
      return;
    } else {
      setShapes((s) => [...s, d]);
    }
    nativeHaptic("LIGHT");
  };

  const undo = () => setShapes((s) => s.slice(0, -1));
  const clearAll = () => setShapes([]);

  const save = async () => {
    if (!natural) return;
    setBusy(true);
    try {
      const data: AnnotationData = { ...emptyAnnotation(natural.w, natural.h), shapes };
      await api.put(`/api/photos/${photoId}/annotate`, { annotation_data: data });
      toast.push("success", shapes.length ? "Annotation saved" : "Annotation cleared");
      onSaved();
      onClose();
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Annotate photo"
      footer={
        <div class="flex items-center justify-between" style={{ width: "100%" }}>
          <div class="flex gap-sm">
            <Button variant="secondary" size="sm" disabled={!shapes.length} onClick={undo}>↶ Undo</Button>
            <Button variant="tertiary" size="sm" disabled={!shapes.length} onClick={clearAll}>Clear</Button>
          </div>
          <Button variant="primary" size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</Button>
        </div>
      }
    >
      <div class="annot">
        <div class="annot__tools">
          {(["pen", "rect", "ellipse", "arrow", "text", "crop"] as Tool[]).map((t) => (
            <button
              key={t}
              class={`annot__tool${tool === t ? " annot__tool--on" : ""}`}
              onClick={() => setTool(t)}
              title={t}
            >
              {t === "pen" ? "✏️" : t === "rect" ? "▭" : t === "ellipse" ? "◯" : t === "arrow" ? "↗" : t === "text" ? "T" : "⛶"}
            </button>
          ))}
          <span class="annot__sep" />
          {COLORS.map((c) => (
            <button
              key={c}
              class={`annot__swatch${color === c ? " annot__swatch--on" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`color ${c}`}
            />
          ))}
          <span class="annot__sep" />
          {WIDTHS.map((w) => (
            <button
              key={w}
              class={`annot__tool${width === w ? " annot__tool--on" : ""}`}
              onClick={() => setWidth(w)}
              title={`${w}px`}
            >
              <span style={{ display: "inline-block", width: `${w + 4}px`, height: `${w}px`, background: "currentColor", borderRadius: "999px" }} />
            </button>
          ))}
        </div>

        <div class="annot__stage">
          <img
            ref={imgRef}
            class="annot__img"
            src={originalUrl}
            alt="Photo to annotate"
            onLoad={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              setNatural({ w: el.naturalWidth || el.clientWidth, h: el.naturalHeight || el.clientHeight });
              requestAnimationFrame(syncCanvasSize);
            }}
          />
          <canvas
            ref={canvasRef}
            class="annot__canvas"
            style={{ touchAction: "none", cursor: "crosshair" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
          />
        </div>
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2)" }}>
          Markup is non-destructive — the original photo is never changed. Saving stores the overlay only.
        </p>
      </div>
    </Modal>
  );
}
