/**
 * DocViewerModal — Office Online Viewer in a full-screen overlay.
 *
 * Fetches a short-lived HMAC-signed view URL from
 *   GET /api/jobs/:jobId/generated-documents/:docId/view-url
 * then embeds the document via Microsoft Office Online (docx-safe).
 *
 * Header controls: Print (opens viewer in new tab), Download (direct R2 file).
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { useToast } from "../store/toast";

interface ViewUrlResponse {
  view_url: string;
  file_url: string;
  filename: string;
}

interface DocViewerModalProps {
  jobId: string;
  docId: string;
  filename: string;
  downloadPath: string; // existing /api/jobs/:id/documents/:doc_id/download
  onClose: () => void;
}

export function DocViewerModal({ jobId, docId, filename, downloadPath, onClose }: DocViewerModalProps) {
  const { push } = useToast();
  const [viewData, setViewData] = useState<ViewUrlResponse | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(true);
  const [iframeReady, setIframeReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Fetch view URL on mount
  useEffect(() => {
    setLoadingUrl(true);
    api
      .get<ViewUrlResponse>(`/api/jobs/${jobId}/generated-documents/${docId}/view-url`)
      .then((r) => setViewData(r))
      .catch((e) => {
        push("error", e instanceof ApiError ? e.message : "Failed to load document viewer.");
        onClose();
      })
      .finally(() => setLoadingUrl(false));
  }, [jobId, docId]);

  const displayFilename = viewData?.filename ?? filename;
  const isPdf = displayFilename.toLowerCase().endsWith(".pdf");

  const handlePrint = () => {
    if (!viewData) return;
    if (isPdf) {
      // Native PDF — open the file URL directly (Office Online is for Office formats).
      window.open(viewData.file_url, "_blank");
      return;
    }
    window.open(
      `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(viewData.file_url)}`,
      "_blank",
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        background: "rgba(0,0,0,0.6)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          margin: "auto",
          width: "90vw",
          height: "90vh",
          maxWidth: "1200px",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-sm)",
            padding: "var(--space-sm) var(--space-md)",
            borderBottom: "1px solid var(--border)",
            background: "var(--surface-raised)",
            flexShrink: 0,
          }}
        >
          {/* Filename */}
          <span
            style={{
              flex: 1,
              fontFamily: "monospace",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={displayFilename}
          >
            {displayFilename}
          </span>

          {/* Print */}
          <button
            onClick={handlePrint}
            title="Print / Open in new tab"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "4px 6px", borderRadius: 4, lineHeight: 1 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
          </button>

          {/* Download */}
          <a
            href={downloadPath}
            download={displayFilename}
            title={`Download ${isPdf ? "PDF" : "document"}`}
            style={{ color: "var(--text-muted)", padding: "4px 6px", borderRadius: 4, lineHeight: 1, textDecoration: "none", display: "flex", alignItems: "center" }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>

          {/* Close */}
          <button
            onClick={onClose}
            title="Close"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: "4px 6px", borderRadius: 4, fontSize: 20, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ position: "relative", flex: 1, background: "#f5f5f5" }}>
          {/* Loading overlay (shown until iframe fires onLoad OR while fetching view URL) */}
          {(loadingUrl || (!iframeReady && viewData)) && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "var(--space-sm)",
                background: "#f5f5f5",
                zIndex: 1,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  border: "3px solid var(--border)",
                  borderTopColor: "var(--color-primary)",
                  borderRadius: "50%",
                  animation: "spin 0.8s linear infinite",
                }}
              />
              <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                {loadingUrl ? "Preparing document…" : "Loading viewer…"}
              </span>
            </div>
          )}

          {viewData && (
            <iframe
              ref={iframeRef}
              src={viewData.view_url}
              onLoad={() => setIframeReady(true)}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                display: "block",
                opacity: iframeReady ? 1 : 0,
              }}
              title={displayFilename}
              allow="print"
            />
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
