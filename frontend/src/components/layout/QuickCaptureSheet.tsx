import { useEffect, useState } from "preact/hooks";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { go } from "../../lib/nav";
import { api } from "../../api";

type PickerMode = "task" | "expense" | "daily_log" | null;

interface ActiveJob {
  id: string;
  title: string | null;
  client_name: string | null;
}

const OPTIONS = [
  { key: "photo" as const, icon: "📷", label: "Add Photo" },
  { key: "voice" as const, icon: "🎤", label: "Voice Note" },
  { key: "task" as const, icon: "✅", label: "Add Task" },
  { key: "expense" as const, icon: "💵", label: "Log Expense" },
  { key: "daily_log" as const, icon: "📝", label: "Daily Log" },
];

function jobLabel(j: ActiveJob): string {
  const title = j.title ?? j.client_name ?? "Job";
  return title;
}

export function QuickCaptureSheet({
  open,
  jobId,
  onClose,
}: {
  open: boolean;
  jobId: string | null;
  onClose: () => void;
}) {
  const [pickerMode, setPickerMode] = useState<PickerMode>(null);
  const [jobs, setJobs] = useState<ActiveJob[] | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setPickerMode(null);
      setJobs(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !pickerMode) return;
    setJobsLoading(true);
    api
      .get<{ jobs: ActiveJob[] }>("/api/jobs/active")
      .then((r) => setJobs(r.jobs ?? []))
      .catch(() => setJobs([]))
      .finally(() => setJobsLoading(false));
  }, [open, pickerMode]);

  if (!open) return null;

  const finish = () => {
    setPickerMode(null);
    onClose();
  };

  const goWithJob = (pickedJobId: string, tab: string) => {
    finish();
    go(`/jobs/${pickedJobId}?tab=${tab}`);
  };

  const onOption = (key: (typeof OPTIONS)[number]["key"]) => {
    switch (key) {
      case "photo":
        finish();
        if (jobId) go(`/jobs/${jobId}?tab=photos`);
        else go("/photos?action=upload");
        break;
      case "voice":
        finish();
        if (jobId) go(`/voice-note?job_id=${encodeURIComponent(jobId)}`);
        else go("/voice-note");
        break;
      case "task":
        if (jobId) goWithJob(jobId, "tasks");
        else setPickerMode("task");
        break;
      case "expense":
        if (jobId) goWithJob(jobId, "financial");
        else setPickerMode("expense");
        break;
      case "daily_log":
        if (jobId) goWithJob(jobId, "daily_logs");
        else setPickerMode("daily_log");
        break;
    }
  };

  const pickerTab =
    pickerMode === "task" ? "tasks" : pickerMode === "expense" ? "financial" : "daily_logs";
  const pickerTitle =
    pickerMode === "task"
      ? "Pick a job for the task"
      : pickerMode === "expense"
        ? "Pick a job for the expense"
        : "Pick a job for the daily log";

  return (
    <>
      <div class="quick-capture-sheet__backdrop" onClick={finish} aria-hidden="true" />
      <div class="quick-capture-sheet quick-capture-sheet--open" role="dialog" aria-modal="true" aria-label="Quick capture">
        <div class="quick-capture-sheet__handle" aria-hidden="true" />

        {pickerMode ? (
          <>
            <p class="quick-capture-sheet__title">{pickerTitle}</p>
            {jobsLoading && <Spinner center />}
            {!jobsLoading && (jobs?.length ?? 0) === 0 && (
              <p class="text--muted" style={{ textAlign: "center", padding: "var(--space-md)" }}>
                No active jobs found.
              </p>
            )}
            {!jobsLoading &&
              jobs?.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  class="quick-capture-option"
                  onClick={() => goWithJob(j.id, pickerTab)}
                >
                  <span>{jobLabel(j)}</span>
                </button>
              ))}
            <div style={{ marginTop: "var(--space-md)", textAlign: "center" }}>
              <Button variant="secondary" onClick={() => setPickerMode(null)}>
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            {OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                class="quick-capture-option"
                onClick={() => onOption(opt.key)}
              >
                <span class="quick-capture-option__icon" aria-hidden="true">
                  {opt.icon}
                </span>
                <span>{opt.label}</span>
              </button>
            ))}
            <div style={{ marginTop: "var(--space-md)", textAlign: "center" }}>
              <Button variant="secondary" onClick={finish}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
