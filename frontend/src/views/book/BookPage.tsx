/**
 * Public estimate booking page. The token in the URL is the only credential.
 */

import { useEffect, useMemo, useState } from "preact/hooks";

interface Slot {
  start: string;
  date: string;
  label: string;
}

interface BookingPayload {
  state: string;
  first_name?: string;
  job_type?: string;
  address?: string;
  needs_address?: boolean;
  slots?: Slot[];
  phone?: string;
  message?: string;
  error?: string;
  appointment?: { start: string | null; label: string; when: string };
}

function tokenFromPath(): string {
  const m = window.location.pathname.match(/\/book\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
  return utc.toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

async function readJson(res: Response): Promise<BookingPayload> {
  return (await res.json().catch(() => ({}))) as BookingPayload;
}

export function BookPage() {
  const token = tokenFromPath();
  const [data, setData] = useState<BookingPayload | null>(null);
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [address, setAddress] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    if (!token) {
      setData({ state: "invalid", phone: "501-263-2050" });
      return;
    }
    const res = await fetch(`/api/public/book/${encodeURIComponent(token)}`);
    setData(await readJson(res));
  };

  useEffect(() => {
    void load().catch(() => setData({ state: "unavailable", phone: "501-263-2050", message: "Please call or text us to pick a time." }));
  }, []);

  const days = useMemo(() => {
    const seen: string[] = [];
    for (const s of data?.slots ?? []) {
      if (!seen.includes(s.date)) seen.push(s.date);
    }
    return seen;
  }, [data]);

  useEffect(() => {
    if (!day && days[0]) setDay(days[0]);
  }, [days, day]);

  const phone = data?.phone || "501-263-2050";
  const times = (data?.slots ?? []).filter((s) => s.date === day);

  const book = async () => {
    if (!slot) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/public/book/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: slot.start, address }),
      });
      const body = await readJson(res);
      if (res.status === 409 || body.error === "slot_taken") {
        setData({ ...body, state: "taken" });
        setSlot(null);
        setConfirming(false);
        setError("That time was just taken. Pick another.");
        return;
      }
      if (body.error === "address_required") {
        setError("Add the property address so Tony can find you.");
        return;
      }
      if (!res.ok) {
        setData(body);
        setError(body.message || "Please call or text us to pick a time.");
        return;
      }
      setData(body);
      setConfirming(false);
    } catch {
      setError("Please call or text us to pick a time.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ maxWidth: "32rem", margin: "0 auto", padding: "var(--space-lg) var(--space-md) 4rem" }}>
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", letterSpacing: "0.04em" }}>COLUMBUS HOME SOLUTIONS</p>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-2xl)", margin: "var(--space-xs) 0 var(--space-md)" }}>
        Book your estimate visit
      </h1>

      {!data && <p>Loading times…</p>}

      {data && data.state === "invalid" && (
        <p>This link isn't valid. Call or text <a href={`tel:${phone}`}>{phone}</a>.</p>
      )}
      {data && data.state === "expired" && (
        <p>This link has expired. Call or text <a href={`tel:${phone}`}>{phone}</a> and we'll find a time.</p>
      )}
      {data && data.state === "disabled" && (
        <p>Online booking isn't open right now. Call or text <a href={`tel:${phone}`}>{phone}</a>.</p>
      )}
      {data && (data.state === "unavailable" || data.state === "closed") && (
        <p>{data.message || "Please call or text us."} <a href={`tel:${phone}`}>{phone}</a></p>
      )}
      {data && data.state === "booked" && data.appointment && (
        <section class="card">
          <div class="card__body">
            <p>You're booked{data.first_name ? `, ${data.first_name}` : ""}.</p>
            <p><strong>{data.appointment.when || data.appointment.label} Central</strong></p>
            {data.address && <p>{data.address}</p>}
            <p>You'll get a text confirmation. {data.message}</p>
          </div>
        </section>
      )}
      {data && (data.state === "open" || data.state === "none" || data.state === "taken") && (
        <section>
          <p>
            {data.first_name ? `Hi ${data.first_name}. ` : ""}
            Tony will come out to look at your {data.job_type ? data.job_type.replace(/[_-]+/g, " ") : "project"}.
            Times are Central.
          </p>
          {error && <p>{error}</p>}
          {data.state === "none" || (data.slots ?? []).length === 0 ? (
            <p>No open times in the next two weeks. Call or text <a href={`tel:${phone}`}>{phone}</a>.</p>
          ) : confirming && slot ? (
            <div class="card">
              <div class="card__body">
                <p><strong>{dayLabel(slot.date)} at {slot.label} Central</strong></p>
                {data.needs_address ? (
                  <label class="form-label">Property address
                    <input class="form-input" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
                  </label>
                ) : (
                  data.address && <p>{data.address}</p>
                )}
                <div class="flex gap-sm" style={{ marginTop: "var(--space-md)" }}>
                  <button type="button" class="btn btn--secondary" onClick={() => setConfirming(false)}>Back</button>
                  <button type="button" class="btn btn--primary" disabled={busy} onClick={book}>
                    {busy ? "Booking…" : "Confirm"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: "var(--space-xs)", overflowX: "auto", marginBottom: "var(--space-md)" }}>
                {days.map((d) => (
                  <button
                    key={d}
                    type="button"
                    class={d === day ? "btn btn--primary" : "btn btn--secondary"}
                    onClick={() => { setDay(d); setSlot(null); }}
                  >
                    {dayLabel(d)}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-sm)" }}>
                {times.map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    class="btn btn--secondary"
                    onClick={() => { setSlot(s); setConfirming(true); setError(""); }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
