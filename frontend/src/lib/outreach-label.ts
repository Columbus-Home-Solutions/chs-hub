/** Glance text for a lead sitting in Contacted. */

export function outreachLabel(lead: {
  status: string;
  lead_outreach_count: number;
  last_outreach_date: string | null;
  lead_outreach_sequence_active: boolean;
}): string | null {
  if (lead.status !== "contacted") return null;
  if (lead.lead_outreach_count >= 3) return "No response";
  if (lead.lead_outreach_count > 0) {
    const sent = weekdayLabel(lead.last_outreach_date);
    return `Text ${lead.lead_outreach_count} of 3${sent ? ` · sent ${sent}` : ""}`;
  }
  if (lead.lead_outreach_sequence_active) return "Text pending";
  return null;
}

function weekdayLabel(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
  }).format(t);
}
