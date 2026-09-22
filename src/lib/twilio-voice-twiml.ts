/**
 * Pure TwiML builders for inbound voice (whisper + missed-call intake).
 * Kept side-effect-free so XML escaping can be unit-tested without Twilio.
 */

export const INTAKE_PROMPT =
  "Thanks for calling Columbus Home Solutions! Please tell us your name and briefly what you're calling about, then we'll connect you.";

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function spellDigits(digits: string): string {
  return digits.replace(/\D/g, "").slice(-10).split("").join(" ");
}

export function capTranscript(raw: string, max = 400): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd();
}

export function buildWhisperSayText(opts: {
  name?: string | null;
  digits?: string | null;
  transcript?: string | null;
  /** True when the unknown-caller Gather already ran (empty transcript = spam cue). */
  intakeAttempted?: boolean;
}): string {
  const transcript = (opts.transcript ?? "").trim();
  if (transcript) return `Caller says: ${transcript}`;
  const name = (opts.name ?? "").trim();
  if (name) return `Incoming call from ${name}.`;
  const digits = (opts.digits ?? "").replace(/\D/g, "").slice(-10);
  if (digits && opts.intakeAttempted) {
    return `No name given — possible spam, incoming call from ${spellDigits(digits)}.`;
  }
  if (digits) return `Incoming call from ${spellDigits(digits)}.`;
  return "Incoming call.";
}

export function buildWhisperTwiml(sayText: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="alice">${escapeXmlText(sayText)}</Say></Response>`
  );
}

export function buildDialTwiml(opts: {
  forwardNumber: string;
  whisperUrl: string;
  /** Omit to restore today's whisper-only Dial (no missed-call callback). */
  actionUrl?: string | null;
}): string {
  const actionAttr = opts.actionUrl
    ? ` action="${escapeXmlText(opts.actionUrl)}" method="POST"`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial${actionAttr}>` +
    `<Number method="GET" url="${escapeXmlText(opts.whisperUrl)}">${escapeXmlText(opts.forwardNumber)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

export function buildGatherTwiml(opts: {
  prompt: string;
  actionUrl: string;
  fallbackUrl: string;
}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Gather input="speech" speechTimeout="auto" timeout="8" action="${escapeXmlText(opts.actionUrl)}" method="POST">` +
    `<Say voice="alice">${escapeXmlText(opts.prompt)}</Say>` +
    `</Gather>` +
    `<Redirect method="POST">${escapeXmlText(opts.fallbackUrl)}</Redirect>` +
    `</Response>`
  );
}

/**
 * Immediate Dial with no whisper / Gather / Hangup — Google LSA tracking line.
 * Optional actionUrl is a Dial-complete callback only (empty TwiML after the
 * bridge ends). It must never delay or replace the Dial itself.
 */
export function buildForwardDialTwiml(forwardNumber: string, actionUrl?: string | null): string {
  const actionAttr = actionUrl
    ? ` action="${escapeXmlText(actionUrl)}" method="POST"`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial${actionAttr}>` +
    `<Number>${escapeXmlText(forwardNumber)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

export function emptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}
