import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  Excalidraw,
  exportToBlob,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
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

type SketchSceneData = ReturnType<typeof restore>;

function parseSketchData(dataString: string | null): SketchSceneData | null {
  if (!dataString) return null;
  try {
    const parsed = JSON.parse(dataString) as ImportedDataState;
    return restore(parsed, null, null);
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
  const suppressDirtyRef = useRef(false);

  const [sketches, setSketches] = useState<SketchMeta[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [initialSketchData, setInitialSketchData] = useState<SketchSceneData | null>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [canvasLoading, setCanvasLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);

  const activeSketch = sketches[activeIndex] ?? null;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const applySceneToCanvas = useCallback(
    (api: ExcalidrawImperativeAPI, scene: SketchSceneData | null) => {
      suppressDirtyRef.current = true;
      if (scene?.elements?.length) {
        api.updateScene({
          elements: scene.elements,
          appState: scene.appState,
        });
        const fileValues = Object.values(scene.files ?? {});
        if (fileValues.length > 0) {
          api.addFiles(fileValues);
        }
      } else {
        api.resetScene();
      }
      setDirty(false);
      requestAnimationFrame(() => {
        suppressDirtyRef.current = false;
      });
    },
    [],
  );

  const loadSketchData = useCallback(
    async (sketchId: string, canvasApi: ExcalidrawImperativeAPI | null) => {
      setCanvasLoading(true);
      try {
        const res = await api.get<{ data: string | null }>(
          `/api/estimate-requests/${requestId}/sketches/${sketchId}/data`,
        );
        const scene = parseSketchData(res.data);
        if (canvasApi) {
          applySceneToCanvas(canvasApi, scene);
        } else {
          setInitialSketchData(scene);
        }
      } finally {
        setCanvasLoading(false);
      }
    },
    [applySceneToCanvas, requestId],
  );

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
        await loadSketchData(list[0].id, null);
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
    };
  }, [requestId, loadSketchData, onClose, toast]);

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const sketch = sketches[activeIndex];
    if (!excalidrawAPI || !sketch) return true;

    setSaving(true);
    setSaveError(null);
    try {
      const elements = excalidrawAPI.getSceneElements();
      const appState = excalidrawAPI.getAppState();
      const data = serializeAsJSON(
        elements,
        appState,
        excalidrawAPI.getFiles(),
        "local",
      );

      let thumbnail: Blob | null = null;
      if (elements.length > 0) {
        try {
          thumbnail = await exportToBlob({
            elements: excalidrawAPI.getSceneElements(),
            appState: excalidrawAPI.getAppState(),
            files: excalidrawAPI.getFiles(),
            mimeType: "image/png",
            quality: 0.8,
          });
        } catch {
          thumbnail = null;
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
  }, [activeIndex, excalidrawAPI, requestId, sketches]);

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
    if (excalidrawAPI) {
      await loadSketchData(sketches[index].id, excalidrawAPI);
    }
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
      if (excalidrawAPI) {
        await loadSketchData(created.sketch.id, excalidrawAPI);
      }
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
      if (excalidrawAPI) {
        await loadSketchData(next[newIndex].id, excalidrawAPI);
      }
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : "Delete failed");
    }
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
          {canvasLoading && (
            <div class="sketch-modal__canvas-loading">Loading sketch…</div>
          )}
          <div style={{ width: "100%", height: "100%", position: "relative" }}>
            <Excalidraw
              initialData={initialSketchData ?? undefined}
              excalidrawAPI={(api) => setExcalidrawAPI(api)}
              onChange={() => {
                if (suppressDirtyRef.current) return;
                setDirty(true);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
