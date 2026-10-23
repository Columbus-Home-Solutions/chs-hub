/**
 * Day-rate check-in. No login. The token in the URL is the credential.
 * True subcontractors never reach this view.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import logoUrl from "../../assets/chs-logo.png";
import { errorCopy, formatDay, t, type CopyKey, type WorkerLang } from "../../lib/worker-copy";

export interface CheckinJob {
  id: string;
  job_number: string | number | null;
  title: string | null;
  street: string | null;
}

export interface CheckinRecent {
  id: string;
  work_date: string;
  days: number;
  state: string;
  can_undo: boolean;
  job: CheckinJob;
}

export interface CheckinPayload {
  greeting: string;
  name?: string;
  language?: WorkerLang;
  today: string;
  jobs: CheckinJob[];
  recent: CheckinRecent[];
}

function LanguageToggle({ lang, onPick }: { lang: WorkerLang; onPick: (next: WorkerLang) => void }) {
  return (
    <div class="checkin__lang">
      <button type="button" aria-current={lang === "en" ? "true" : undefined} onClick={() => onPick("en")}>English</button>
      <span>|</span>
      <button type="button" aria-current={lang === "es" ? "true" : undefined} onClick={() => onPick("es")}>Español</button>
    </div>
  );
}

function useWorkerLanguage(token: string, initial?: WorkerLang) {
  const [lang, setLang] = useState<WorkerLang>(initial === "es" ? "es" : "en");
  const local = useRef(false);
  useEffect(() => {
    document.documentElement.lang = lang === "es" ? "es" : "en";
  }, [lang]);
  function adopt(next: WorkerLang | undefined) {
    if (!local.current && (next === "en" || next === "es")) setLang(next);
  }
  function pick(next: WorkerLang) {
    local.current = true;
    setLang(next);
    const send = (attempt: number) => fetch(`/api/sub/${encodeURIComponent(token)}/language`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: next }),
    }).then((res) => {
      if (!res.ok) throw new Error("save");
    }).catch(() => {
      if (attempt < 1) window.setTimeout(() => send(attempt + 1), 4000);
    });
    void send(0);
  }
  return { lang, adopt, pick };
}

function jobLabel(job: CheckinJob): string {
  const num = job.job_number != null ? `${job.job_number} ` : "";
  return `${num}${job.title ?? "Job"}${job.street ? ` — ${job.street}` : ""}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export function CheckInPage({ token }: { token: string }) {
  const [data, setData] = useState<CheckinPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState("");
  const [workDate, setWorkDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [counts, setCounts] = useState({ schedule_new: 0, punch_new: 0 });
  const [hideTip, setHideTip] = useState(
    typeof localStorage !== "undefined" && localStorage.getItem("chs-checkin-tip") === "1",
  );
  const { lang, adopt, pick } = useWorkerLanguage(token);

  useEffect(() => {
    document.title = "CHS Check In";
    let link = document.querySelector<HTMLLinkElement>("link[rel='manifest']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.appendChild(link);
    }
    link.href = `/api/sub/${encodeURIComponent(token)}/manifest.webmanifest`;
    const icon = document.querySelector<HTMLLinkElement>("link[rel='apple-touch-icon']") ?? document.createElement("link");
    icon.rel = "apple-touch-icon";
    icon.href = logoUrl;
    document.head.appendChild(icon);
  }, [token]);

  async function load() {
    const res = await fetch(`/api/sub/${encodeURIComponent(token)}/checkin`);
    const body = await readJson(res);
    if (!res.ok) throw new Error(errorCopy("en", String(body.error || "")) || String(body.message || "This link isn't working"));
    const payload = body as unknown as CheckinPayload;
    setData(payload);
    adopt(payload.language);
    setWorkDate((current) => current || payload.today);
    const countsRes = await fetch(`/api/sub/${encodeURIComponent(token)}/counts`);
    if (countsRes.ok) setCounts(await countsRes.json());
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [token]);

  async function submit(days: number) {
    if (!jobId) {
      setNotice("Pick the job first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/sub/${encodeURIComponent(token)}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, work_date: workDate, days }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        setNotice(errorCopy(lang, String(body.error || "")) || String(body.message || t(lang, "link_dead")));
        return;
      }
      setNotice(body.idempotent ? t(lang, "already_in") : t(lang, "will_confirm"));
      setJobId("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/sub/${encodeURIComponent(token)}/checkin/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <main class="checkin"><p>{error}</p></main>;
  if (!data) return <main class="checkin"><p>{t(lang, "loading")}</p></main>;

  const yesterday = shiftDate(data.today, -1);
  const stateLabel = (state: string) => {
    const key = state === "pending" || state === "confirmed" || state === "paid" || state === "removed" ? state : "pending";
    return t(lang, key as CopyKey);
  };

  return (
    <main class="checkin">
      <LanguageToggle lang={lang} onPick={pick} />
      <img class="checkin__logo" src={logoUrl} alt="Columbus Home Solutions" />
      <h1>{t(lang, "hi", { name: data.name || data.greeting.replace(/^Hi\s/, "") })}</h1>
      <p class="checkin__lead">{workDate === yesterday ? t(lang, "where_yesterday") : t(lang, "where_today")}</p>
      <label class="checkin__label">
        {t(lang, "job")}
        <select value={jobId} onChange={(e) => setJobId((e.target as HTMLSelectElement).value)}>
          <option value="">{t(lang, "pick_job")}</option>
          {data.jobs.map((job) => (
            <option key={job.id} value={job.id}>{jobLabel(job)}</option>
          ))}
        </select>
      </label>
      <label class="checkin__label">
        {t(lang, "day")}
        <select value={workDate} onChange={(e) => setWorkDate((e.target as HTMLSelectElement).value)}>
          <option value={data.today}>{t(lang, "today")}</option>
          <option value={yesterday}>{t(lang, "yesterday")}</option>
        </select>
      </label>
      <div class="checkin__actions">
        <button type="button" disabled={busy} onClick={() => submit(1)}>{t(lang, "full_day")}</button>
        <button type="button" disabled={busy} onClick={() => submit(0.5)}>{t(lang, "half_day")}</button>
      </div>
      {notice && <p class="checkin__notice">{notice}</p>}
      <h2>{t(lang, "recent")}</h2>
      {data.recent.length === 0 && <p>{t(lang, "none_yet")}</p>}
      <ul class="checkin__recent">
        {data.recent.map((entry) => (
          <li key={entry.id}>
            <span>{formatDay(entry.work_date, lang)} · {jobLabel(entry.job)} · {entry.days === 0.5 ? t(lang, "half") : t(lang, "full")} · {stateLabel(entry.state)}</span>
            {entry.can_undo && (
              <button type="button" onClick={() => undo(entry.id)}>{t(lang, "undo")}</button>
            )}
          </li>
        ))}
      </ul>
      {!hideTip && (
        <div class="checkin__tip">
          <p><strong>{t(lang, "tip_title")}</strong></p>
          <p>{t(lang, "tip_why")}</p>
          <p>{t(lang, "tip_1")}<br />{t(lang, "tip_2")}<br />{t(lang, "tip_3")}</p>
          <p>{t(lang, "tip_android")}</p>
          <button type="button" onClick={() => { localStorage.setItem("chs-checkin-tip", "1"); setHideTip(true); }}>{t(lang, "tip_done")}</button>
        </div>
      )}
      <div class="checkin__tiles">
        <a href={`/sub/${token}/schedule`}>
          {t(lang, "my_schedule")}
          {counts.schedule_new > 0 && <span class="checkin__dot">{t(lang, "coming", { n: counts.schedule_new })}</span>}
        </a>
        <a href={`/sub/${token}/punch`}>
          {t(lang, "punch_list")}
          {counts.punch_new > 0 && <span class="checkin__dot">{t(lang, "open", { n: counts.punch_new })}</span>}
        </a>
      </div>
    </main>
  );
}

function statusLabel(lang: WorkerLang, status: string | null): string {
  if (status === "in_progress") return t(lang, "in_progress");
  if (status === "weather_delay") return t(lang, "weather_delay");
  if (status === "scheduled") return t(lang, "scheduled_by");
  return status ?? "";
}

export function CheckInSchedule({ token }: { token: string }) {
  const [entries, setEntries] = useState<{ id: string; date: string; start_time: string | null; status: string | null; title: string | null; job_number: string | number | null; street: string | null; is_new: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { lang, adopt, pick } = useWorkerLanguage(token);
  useEffect(() => {
    fetch(`/api/sub/${encodeURIComponent(token)}/schedule`)
      .then(async (res) => {
        const body = await readJson(res);
        if (!res.ok) throw new Error(errorCopy("en", String(body.error || "")) || String(body.message || "Not available"));
        adopt(body.language as WorkerLang);
        setEntries((body.entries as typeof entries) ?? []);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <main class="checkin">
      <LanguageToggle lang={lang} onPick={pick} />
      <a href={`/sub/${token}`}>{t(lang, "back")}</a>
      <h1>{t(lang, "my_schedule")}</h1>
      {error && <p>{error}</p>}
      {entries.length === 0 && !error && <p>{t(lang, "nothing_scheduled")}</p>}
      <ul>
        {entries.map((entry) => (
          <li key={entry.id}>
            {entry.is_new && <span class="checkin__dot">{t(lang, "new")}</span>}
            {formatDay(entry.date, lang)} {entry.start_time ?? ""} · {entry.job_number} {entry.title} · {entry.street}
            {entry.status && entry.status !== "scheduled" ? ` · ${statusLabel(lang, entry.status)}` : ""}
          </li>
        ))}
      </ul>
      <p class="checkin__lead">{t(lang, "plans_change")}</p>
    </main>
  );
}

export function CheckInPunch({ token }: { token: string }) {
  const [items, setItems] = useState<{ id: string; description: string; job_number: string | number | null; title: string | null; property_address: string | null; is_new?: boolean }[]>([]);
  const { lang, adopt, pick } = useWorkerLanguage(token);
  useEffect(() => {
    fetch(`/api/sub/${encodeURIComponent(token)}/punch`)
      .then((res) => res.json())
      .then((body) => {
        adopt(body.language);
        setItems(body.items ?? []);
      });
  }, [token]);
  return (
    <main class="checkin">
      <LanguageToggle lang={lang} onPick={pick} />
      <a href={`/sub/${token}`}>{t(lang, "back")}</a>
      <h1>{t(lang, "punch_list")}</h1>
      {items.length === 0 && <p>{t(lang, "caught_up")}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.is_new && <span class="checkin__dot">{t(lang, "new")}</span>}
            {item.job_number} {item.title} · {item.property_address} — {item.description}
          </li>
        ))}
      </ul>
    </main>
  );
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
