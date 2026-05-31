/**
 * Smart-note AI processing (Sprint 8).
 *
 * Takes raw note text (typed, or a voice transcript produced client-side — the
 * server does NOT do audio transcription this sprint) and asks Claude to:
 *   - summarise it,
 *   - categorise it, and
 *   - extract any actionable task / expense / change-order it implies.
 *
 * The extractions are SUGGESTIONS only. Nothing is created automatically; the
 * accept-task / accept-expense / accept-change-order endpoints turn a reviewed
 * suggestion into a real record (business rule #4). Never throws for "AI
 * unavailable" — returns { ok:false } so the note persists unprocessed and can
 * be re-processed later.
 */

import type { Env } from "../env.js";
import { claudeMessages, extractJson } from "./claude.js";

export const NOTE_CATEGORIES = [
  "general",
  "task",
  "expense",
  "change_order",
  "scheduling",
  "client_communication",
] as const;

export interface ExtractedTask {
  title: string;
  task_group?: string | null;
  notes?: string | null;
}
export interface ExtractedExpense {
  vendor: string | null;
  amount: number | null;
  category: string | null;
  description: string | null;
}
export interface ExtractedChangeOrder {
  title: string | null;
  description: string | null;
  amount: number | null;
}

export interface NoteProcessing {
  ok: boolean;
  summary: string | null;
  category: string | null;
  tasks: ExtractedTask[];
  expense: ExtractedExpense | null;
  change_order: ExtractedChangeOrder | null;
  error: string | null;
}

const SYSTEM = [
  "You are a field assistant for Columbus Home Solutions, a residential general contractor.",
  "A crew member or PM dictated/typed a note from a job site. Analyse it and return ONLY a JSON object (no prose, no markdown fences):",
  "{",
  '  "summary": "1-2 sentence summary",',
  `  "category": "one of: ${NOTE_CATEGORIES.join(" | ")}",`,
  '  "tasks": [ {"title":"short actionable task","task_group":"e.g. Punch List or null"} ],',
  '  "expense": {"vendor":"store or null","amount":<number or null>,"category":"materials|tools|subcontractor|other","description":"what was bought"} or null,',
  '  "change_order": {"title":"short title","description":"what the client wants added/changed","amount":<estimated number or null>} or null',
  "}",
  "Only include an expense if the note clearly describes a purchase. Only include a change_order if the client requested work beyond the original scope. Return [] for tasks if none. Pick the single best category.",
].join("\n");

export async function processNote(
  env: Env,
  rawContent: string,
  context?: { jobTitle?: string | null },
): Promise<NoteProcessing> {
  const empty: NoteProcessing = {
    ok: false,
    summary: null,
    category: null,
    tasks: [],
    expense: null,
    change_order: null,
    error: null,
  };

  const userText =
    (context?.jobTitle ? `Job: ${context.jobTitle}\n\n` : "") + `Note:\n${rawContent}`;

  const call = await claudeMessages(env, {
    system: SYSTEM,
    maxTokens: 1024,
    messages: [{ role: "user", content: userText }],
  });
  if (!call.ok) return { ...empty, error: call.error };

  const parsed = extractJson<{
    summary?: unknown;
    category?: unknown;
    tasks?: unknown;
    expense?: unknown;
    change_order?: unknown;
  }>(call.text);
  if (!parsed) return { ...empty, error: "note_json_parse_failed" };

  return {
    ok: true,
    summary: typeof parsed.summary === "string" ? parsed.summary.trim() || null : null,
    category: normalizeCategory(parsed.category),
    tasks: normalizeTasks(parsed.tasks),
    expense: normalizeExpense(parsed.expense),
    change_order: normalizeChangeOrder(parsed.change_order),
    error: null,
  };
}

function normalizeCategory(v: unknown): string {
  if (typeof v !== "string") return "general";
  const c = v.trim().toLowerCase().replace(/\s+/g, "_");
  return (NOTE_CATEGORIES as readonly string[]).includes(c) ? c : "general";
}

function normalizeTasks(v: unknown): ExtractedTask[] {
  if (!Array.isArray(v)) return [];
  const out: ExtractedTask[] = [];
  for (const t of v) {
    if (t && typeof t === "object") {
      const o = t as Record<string, unknown>;
      const title = typeof o.title === "string" ? o.title.trim() : "";
      if (title) {
        out.push({
          title,
          task_group: typeof o.task_group === "string" ? o.task_group.trim() || null : null,
          notes: typeof o.notes === "string" ? o.notes.trim() || null : null,
        });
      }
    } else if (typeof t === "string" && t.trim()) {
      out.push({ title: t.trim(), task_group: null, notes: null });
    }
  }
  return out;
}

function normalizeExpense(v: unknown): ExtractedExpense | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const amount = Number(o.amount);
  const vendor = typeof o.vendor === "string" ? o.vendor.trim() || null : null;
  const description = typeof o.description === "string" ? o.description.trim() || null : null;
  // Require at least a vendor or amount to count as an expense suggestion.
  if (!vendor && !(Number.isFinite(amount) && amount > 0)) return null;
  return {
    vendor,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    category: typeof o.category === "string" ? o.category.trim() || null : null,
    description,
  };
}

function normalizeChangeOrder(v: unknown): ExtractedChangeOrder | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() || null : null;
  const description = typeof o.description === "string" ? o.description.trim() || null : null;
  const amount = Number(o.amount);
  if (!title && !description) return null;
  return {
    title,
    description,
    amount: Number.isFinite(amount) ? amount : null,
  };
}
