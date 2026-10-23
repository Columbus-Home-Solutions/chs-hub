/** Draft Spanish for the day-rate public pages. Missing Spanish keys fall back to English. */

export type WorkerLang = "en" | "es";

const EN = {
  hi: "Hi {name}",
  today: "Today",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
  where_today: "Where did you work today?",
  where_yesterday: "Where did you work yesterday?",
  pick_job: "Choose a job",
  job: "Job",
  day: "Day",
  full_day: "Full day",
  half_day: "Half day",
  full: "Full",
  half: "Half",
  will_confirm: "Tony will confirm it.",
  already_in: "That day is already in.",
  undo: "Undo",
  recent: "Your recent days",
  none_yet: "No check-ins yet.",
  pending: "Pending",
  confirmed: "Confirmed",
  paid: "Paid",
  removed: "Removed",
  my_schedule: "My schedule",
  punch_list: "Punch list",
  new: "New",
  back: "← Check in",
  scheduled_by: "Scheduled by Tony",
  in_progress: "In progress",
  weather_delay: "Weather delay",
  plans_change: "Plans can change. Tony will update this if they do.",
  nothing_scheduled: "Nothing scheduled right now.",
  caught_up: "You're all caught up. No open items right now.",
  full_already: "That's a full day already",
  too_far: "You can add today or yesterday. Ask Tony to add older days.",
  link_dead: "This link isn't working",
  ask_new_link: "Ask Tony for a new link.",
  tip_title: "Put this on your home screen",
  tip_why: "Then it's one tap every day.",
  tip_1: "1. Tap the Share button",
  tip_2: "2. Tap Add to Home Screen",
  tip_3: "3. Tap Add",
  tip_done: "Got it, show my jobs",
  tip_android: "Android: tap the menu, then Install app",
  loading: "Loading…",
  coming: "{n} coming up",
  open: "{n} open",
  english: "English",
  spanish: "Español",
  only_en: "English only",
} as const;

const ES: Partial<Record<keyof typeof EN, string>> = {
  hi: "Hola, {name}",
  today: "Hoy",
  yesterday: "Ayer",
  tomorrow: "Mañana",
  where_today: "¿Dónde trabajaste hoy?",
  where_yesterday: "¿Dónde trabajaste ayer?",
  pick_job: "Elige un trabajo",
  job: "Trabajo",
  day: "Día",
  full_day: "Día completo",
  half_day: "Medio día",
  full: "Completo",
  half: "Medio",
  will_confirm: "Tony lo confirmará.",
  already_in: "Ese día ya está registrado.",
  undo: "Deshacer",
  recent: "Tus días recientes",
  none_yet: "Aún no hay registros.",
  pending: "Pendiente",
  confirmed: "Confirmado",
  paid: "Pagado",
  removed: "Eliminado",
  my_schedule: "Mi horario",
  punch_list: "Lista de pendientes",
  new: "Nuevo",
  back: "← Registrar día",
  scheduled_by: "Programado por Tony",
  in_progress: "En progreso",
  weather_delay: "Retraso por clima",
  plans_change: "Los planes pueden cambiar. Tony lo actualizará si cambian.",
  nothing_scheduled: "No hay nada programado por ahora.",
  caught_up: "Estás al día. No hay pendientes abiertos por ahora.",
  full_already: "Ya tienes un día completo",
  too_far: "Puedes agregar hoy o ayer. Pídele a Tony que agregue días anteriores.",
  link_dead: "Este enlace no funciona",
  ask_new_link: "Pídele a Tony un enlace nuevo.",
  tip_title: "Pon esto en tu pantalla de inicio",
  tip_why: "Así entras con un toque cada día.",
  tip_1: "1. Toca el botón Compartir",
  tip_2: "2. Toca Agregar a pantalla de inicio",
  tip_3: "3. Toca Agregar",
  tip_done: "Entendido, mostrar mis trabajos",
  tip_android: "Android: toca el menú y luego Instalar app",
  loading: "Cargando…",
  coming: "{n} próximos",
  open: "{n} abiertos",
  english: "English",
  spanish: "Español",
};

export type CopyKey = keyof typeof EN;

export function t(lang: WorkerLang, key: CopyKey, vars?: Record<string, string | number>): string {
  const template = (lang === "es" ? ES[key] : undefined) || EN[key];
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ""));
}

export function formatDay(iso: string, lang: WorkerLang): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const formatted = new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dt);
  return lang === "es" ? formatted.replace(/\./g, "").toLowerCase() : formatted;
}

export function errorCopy(lang: WorkerLang, code: string | undefined): string | null {
  if (code === "ask_tony") return t(lang, "too_far");
  if (code === "day_cap") return t(lang, "full_already");
  if (code === "not_found" || code === "not_available") return `${t(lang, "link_dead")}. ${t(lang, "ask_new_link")}`;
  return null;
}
