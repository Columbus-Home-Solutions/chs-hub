import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Tldraw, type Editor, type TLEditorSnapshot, type TLStoreSnapshot } from "tldraw";
import "tldraw/tldraw.css";
import "./SketchModal.css";
import { api, ApiError } from "../../api";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import type { SketchMeta } from "../../types";

interface SketchModalProps {
  requestId: string;
  onClose: () => void;
}

type Snapshot = TLEditorSnapshot | TLStoreSnapshot;

async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob | null> {
  try {
    const img = new Image();
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("svg load failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return null;
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  } catch {
    return null;
  }
}

async function putSketchData(
  requestId: string,
  sketchId: string,
  data: string,
  thumbnail: Blob | null,
): Promise<void> {
  const form = new FormData();
  form.append("data", data);
  if (thumbnail) form.append("thumbnail", thumbnail, "thumb.png");
  const res = await fetch(`/api/estimate-requests/${requestId}/sketches/${sketchId}`, {
    method: "PUT",
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = "Save failed";
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
}

export function SketchModal({ requestId, onClose }: SketchModalProps) {
  const toast = useToast();
  const editorRef = useRef<Editor | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const [sketches, setSketches] = useState<SketchMeta[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeSnapshot, setActiveSnapshot] = useState<Snapshot | undefined>(undefined);
  const [canvasKey, setCanvasKey] = useState("");
  const [canvasLoading, setCanvasLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);

  const activeSketch = sketches[activeIndex] ?? null;

  const loadSketchData = useCallback(async (sketchId: string) => {
    setCanvasLoading(true);
    editorRef.current = null;
    unlistenRef.current?.();
    unlistenRef.current = null;
    try {
      const res = await api.get<{ data: string | null }>(
        `/api/estimate-requests/${requestId}/sketches/${sketchId}/data`,
      );
      if (res.data) {
        try {
          setActiveSnapshot(JSON.parse(res.data) as Snapshot);
        } catch {
          setActiveSnapshot(undefined);
        }
      } else {
        setActiveSnapshot(undefined);
      }
      setCanvasKey(sketchId);
    } finally {
      setCanvasLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        let list = (
          await api.get<{ sketches: SketchMeta[] }>(`/api/estimate-requests/${requestId}/sketches`)
        ).sketches;
        if (list.length === 0) {
          const created = await api.post<{ sketch: SketchMeta }>(
            `/api/estimate-requests/${requestId}/sketches`,
            {},
          );
          list = [created.sketch];
        }
        if (cancelled) return;
        setSketches(list);
        setActiveIndex(0);
        await loadSketchData(list[0].id);
      } catch (e) {
        if (!cancelled) {
          toast.push("error", e instanceof ApiError ? e.message : "Failed to load sketches");
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, [requestId, loadSketchData, onClose, toast]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const editor = editorRef.current;
    const sketch = sketches[activeIndex];
    if (!editor || !sketch) return true;

    setSaving(true);
    setSaveError(null);
    try {
      const snapshot = editor.getSnapshot();
      const data = JSON.stringify(snapshot);

      let thumbnail: Blob | null = null;
      const ids = [...editor.getCurrentPageShapeIds()];
      if (ids.length > 0) {
        const svgExport = await editor.getSvgString(ids, { scale: 1, background: true });
        if (svgExport?.svg) {
          thumbnail = await svgToPngBlob(svgExport.svg, svgExport.width, svgExport.height);
        }
      }

      await putSketchData(requestId, sketch.id, data, thumbnail);
      setDirty(false);
      return true;
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "Save failed. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }, [activeIndex, requestId, sketches]);

  const handleClose = useCallback(async () => {
    if (closeConfirm) return;
    if (dirty) {
      const ok = await saveCurrent();
      if (!ok) {
        setCloseConfirm(true);
        return;
      }
    }
    onClose();
  }, [closeConfirm, dirty, onClose, saveCurrent]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmDeleteId) void handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDeleteId, handleClose]);

  const handleSave = async () => {
    const ok = await saveCurrent();
    if (ok) toast.push("success", "Saved");
  };

  const switchTab = async (index: number) => {
    if (index === activeIndex) return;
    if (dirty) {
      const ok = await saveCurrent();
      if (!ok) return;
    }
    setSaveError(null);
    setActiveIndex(index);
    setDirty(false);
    await loadSketchData(sketches[index].id);
  };

  const handleAddPage = async () => {
    if (sketches.length >= 10) {
      toast.push("error", "Maximum of 10 sketches per request.");
      return;
    }
    if (dirty) {
      const ok = await saveCurrent();
      if (!ok) return;
    }
    try {
      const created = await api.post<{ sketch: SketchMeta }>(
        `/api/estimate-requests/${requestId}/sketches`,
        {},
      );
      const next = [...sketches, created.sketch];
      setSketches(next);
      setActiveIndex(next.length - 1);
      setDirty(false);
      await loadSketchData(created.sketch.id);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Could not add page");
    }
  };

  const handleDelete = async (sketchId: string) => {
    const idx = sketches.findIndex((s) => s.id === sketchId);
    if (idx < 0) return;

    if (idx === activeIndex && dirty) {
      const ok = await saveCurrent();
      if (!ok) return;
    }

    try {
      await api.del(`/api/estimate-requests/${requestId}/sketches/${sketchId}`);
      let next = sketches.filter((s) => s.id !== sketchId);
      if (next.length === 0) {
        const created = await api.post<{ sketch: SketchMeta }>(
          `/api/estimate-requests/${requestId}/sketches`,
          {},
        );
        next = [created.sketch];
      }
      setSketches(next);
      setConfirmDeleteId(null);
      const newIndex = Math.min(idx > 0 ? idx - 1 : 0, next.length - 1);
      setActiveIndex(newIndex);
      setDirty(false);
      await loadSketchData(next[newIndex].id);
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Delete failed");
    }
  };

  const handleEditorMount = (editor: Editor) => {
    editorRef.current = editor;
    unlistenRef.current?.();
    unlistenRef.current = editor.store.listen(() => setDirty(true));
    setDirty(false);
  };

  const updateLocalLabel = (sketchId: string, label: string) => {
    setSketches((prev) => prev.map((s) => (s.id === sketchId ? { ...s, label } : s)));
    setEditingLabelId(null);
  };

  if (loading) {
    return (
      <div class="sketch-modal">
        <div class="sketch-modal__canvas-loading">
          <Spinner />
        </div>
      </div>
    );
  }

  return (
    <div class="sketch-modal" onClick={(e) => e.target === e.currentTarget && void handleClose()}>
      <div class="sketch-modal__shell" onClick={(e) => e.stopPropagation()}>
        <header class="sketch-modal__header">
          <button type="button" class="sketch-modal__back-btn" onClick={() => void handleClose()}>
            ← Back
          </button>
          <span class="sketch-modal__header-title">{activeSketch?.label ?? "Sketch"}</span>
          {saveError && !closeConfirm && (
            <span class="sketch-modal__header-error">{saveError}</span>
          )}
          {closeConfirm && (
            <div class="sketch-modal__header-confirm">
              <span>Could not save. Close anyway?</span>
              <Button size="sm" variant="secondary" onClick={() => setCloseConfirm(false)}>
                No
              </Button>
              <Button size="sm" variant="danger" onClick={onClose}>
                Yes
              </Button>
            </div>
          )}
          <Button
            class="sketch-modal__save-btn"
            size="sm"
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </header>

        <nav class="sketch-modal__tabs">
          {sketches.map((sketch, i) => (
            <div
              key={sketch.id}
              class={`sketch-modal__tab-wrap${i === activeIndex ? " sketch-modal__tab-wrap--active" : ""}`}
            >
              {confirmDeleteId === sketch.id ? (
                <div class="sketch-modal__tab-confirm">
                  <span>Delete?</span>
                  <Button size="sm" variant="danger" onClick={() => void handleDelete(sketch.id)}>
                    Yes
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmDeleteId(null)}>
                    No
                  </Button>
                </div>
              ) : (
                <>
                  <button type="button" class="sketch-modal__tab" onClick={() => void switchTab(i)}>
                    <span
                      class="sketch-modal__tab-label"
                      contentEditable={editingLabelId === sketch.id}
                      suppressContentEditableWarning
                      onDblClick={(e) => {
                        e.stopPropagation();
                        setEditingLabelId(sketch.id);
                        requestAnimationFrame(() => (e.target as HTMLSpanElement).focus());
                      }}
                      onBlur={(e) => {
                        const label = (e.target as HTMLSpanElement).innerText.trim();
                        if (label && label !== sketch.label) updateLocalLabel(sketch.id, label);
                        else setEditingLabelId(null);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.target as HTMLSpanElement).blur();
                        }
                      }}
                    >
                      {sketch.label}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="sketch-modal__tab-close"
                    aria-label={`Delete ${sketch.label}`}
                    onClick={() => setConfirmDeleteId(sketch.id)}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
          <button
            type="button"
            class="sketch-modal__add-page"
            disabled={sketches.length >= 10}
            onClick={() => void handleAddPage()}
          >
            + Add page
          </button>
        </nav>

        <div class="sketch-modal__canvas">
          {canvasLoading ? (
            <div class="sketch-modal__canvas-loading">Loading sketch…</div>
          ) : (
            canvasKey && (
              <Tldraw
                key={canvasKey}
                snapshot={activeSnapshot}
                onMount={handleEditorMount}
                autoFocus
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
