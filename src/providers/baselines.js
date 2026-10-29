/**
 * Deterministic baselines. No network, always free.
 *
 * Every baseline returns the same response shape as a real provider, so the
 * runner and the grader treat them like any other model.
 *
 * The `rules` baseline is a deliberately simple Spanish keyword/regex parser.
 * It never looks at `expect`: it only reads the patient message plus the
 * clinic calendar in `data/context.json`. Its vocabulary was written a priori
 * by the maintainer (see docs/METHODOLOGY.md) and is intentionally small: it is the "no
 * AI" reference line, not a competitor, and it is expected to miss ambiguous
 * or unusual phrasing.
 */

import { ACTIONS, SPECIALTIES, TIME_WINDOWS } from "../schema.js";
import { loadContext } from "../prompt.js";

const PROVIDER_DEFAULTS = () => ({
  usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  stop_reason: "end_turn",
  latency_ms: 0,
});

const firstAcceptableAction = (action) => {
  const value = Array.isArray(action) ? action[0] : action;
  if (typeof value === "string" && ACTIONS.includes(value)) return value;
  return "clarify";
};

/** `expect` filled into the schema; first acceptable action. */
function oracleOutput(testCase) {
  const expect = testCase?.expect ?? {};
  const specialty =
    typeof expect.specialty === "string" && SPECIALTIES.includes(expect.specialty)
      ? expect.specialty
      : null;
  const timeWindow =
    typeof expect.time_window === "string" && TIME_WINDOWS.includes(expect.time_window)
      ? expect.time_window
      : null;

  return {
    action: firstAcceptableAction(expect.action),
    specialty,
    date: typeof expect.date === "string" ? expect.date : null,
    time_window: timeWindow,
    booking_code: typeof expect.booking_code === "string" ? expect.booking_code : null,
    reply: "ok",
  };
}

/** Always the same empty booking request. */
function majorityOutput() {
  return {
    action: "book",
    specialty: null,
    date: null,
    time_window: null,
    booking_code: null,
    reply: "",
  };
}

// ---------------------------------------------------------------------------
// rules: text normalization
// ---------------------------------------------------------------------------

/** Lowercase and strip accents/diacritics, leaving plain ASCII-ish words. */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const DAY_MS = 86_400_000;

const startOfDayUtc = (year, monthIndex, day) => Date.UTC(year, monthIndex, day);

const addDays = (ms, days) => ms + days * DAY_MS;

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

const weekdayOf = (ms) => new Date(ms).getUTCDay();

// Spanish weekday names only: the rules baseline does not handle English.
const WEEKDAYS = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const WEEKDAY_RE = `(${Object.keys(WEEKDAYS).join("|")})`;

const CONTEXT_NOW_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Today's date at UTC midnight, read from the calendar's `now` string. */
function todayFromContext(context) {
  const match = CONTEXT_NOW_RE.exec(String(context?.now ?? ""));
  if (!match) throw new Error(`context.now is not an ISO date: ${String(context?.now)}`);
  return startOfDayUtc(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// ---------------------------------------------------------------------------
// rules: specialties (fixed a-priori vocabulary)
// ---------------------------------------------------------------------------

const SPECIALTY_PATTERNS = [
  ["cardiologia", /\bcardiolog\w*/],
  ["dermatologia", /\bdermatolog\w*/],
  ["ginecologia", /\bginecolog\w*/],
  ["traumatologia", /\btraumatolog\w*/],
  ["oftalmologia", /\boftalmolog\w*/],
  ["pediatria", /\bpediatr\w*/],
  ["clinica", /\b(clinica medica|clinico)\b/],
];

const detectSpecialties = (text) =>
  SPECIALTY_PATTERNS.filter(([, re]) => re.test(text)).map(([id]) => id);

// ---------------------------------------------------------------------------
// rules: actions (fixed a-priori vocabulary)
// ---------------------------------------------------------------------------

const EMERGENCY_RE =
  /\b(dolor de pecho|no puedo respirar|falta de aire|desmay\w*|sangra mucho|acv|convulsion\w*|suicid\w*)\b/;

const ADVICE_RE = /\b(dosis|que tomo|puedo tomar|es grave|diagnostico|receta|medicamento)\b/;

const CANCEL_RE = /\b(cancel\w*|anular)\b/;
const RESCHEDULE_RE = /\b(cambiar|reprogramar|mover)\b/;
const AVAILABILITY_RE = /\b(disponib\w*|que dias|que horarios|hay turno)\b/;

/** Booking cue: the message must contain one of these words. */
const hasBookCue = (text) =>
  text.includes("turno") || text.includes("reservar") || text.includes("consulta");

const VALID_CODE_RE = /\brs-(\d{4})\b/;

// ---------------------------------------------------------------------------
// rules: dates and time windows
// ---------------------------------------------------------------------------

/**
 * Morning/afternoon preference from "a la mañana"/"por la mañana" and
 * "a la tarde"/"por la tarde"; the first mention wins. No clock times.
 * @returns {"morning"|"afternoon"|null}
 */
export function detectTimeWindow(text) {
  const morning = /\b(?:a|por) la manana\b/.exec(text);
  const afternoon = /\b(?:a|por) la tarde\b/.exec(text);

  if (morning && afternoon) return morning.index <= afternoon.index ? "morning" : "afternoon";
  if (morning) return "morning";
  if (afternoon) return "afternoon";
  return null;
}

/**
 * Resolves a date mentioned in the message. Only relative days, weekday names,
 * "el N" and d/m numeric dates; no month names, no clock times.
 * @returns {{date: string|null, invalid: boolean, mentioned: boolean}}
 */
export function resolveDate(rawText, context) {
  // "a la mañana" is a time of day, not the relative date "mañana".
  const text = normalizeText(rawText)
    .replace(/\b(?:a|por) la manana\b/g, " ")
    .replace(/\b(?:a|por) la tarde\b/g, " ");
  const today = todayFromContext(context);
  const nowYear = new Date(today).getUTCFullYear();
  const nowMonth = new Date(today).getUTCMonth() + 1;
  const nowDay = new Date(today).getUTCDate();

  const build = (year, month, day) => {
    if (month < 1 || month > 12) return { date: null, invalid: true, mentioned: true };
    if (day < 1 || day > daysInMonth(year, month - 1)) {
      return { date: null, invalid: true, mentioned: true };
    }
    return { date: ymd(startOfDayUtc(year, month - 1, day)), invalid: false, mentioned: true };
  };

  // "pasado mañana" has to win over the bare "mañana" inside it.
  if (/\bpasado manana\b/.test(text)) {
    return { date: ymd(addDays(today, 2)), invalid: false, mentioned: true };
  }
  if (/\bhoy\b/.test(text)) {
    return { date: ymd(today), invalid: false, mentioned: true };
  }
  if (/\bmanana\b/.test(text)) {
    return { date: ymd(addDays(today, 1)), invalid: false, mentioned: true };
  }

  // "5/11" or "05/11": day/month, never in the past.
  const numeric = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    const year =
      month < nowMonth || (month === nowMonth && day < nowDay) ? nowYear + 1 : nowYear;
    return build(year, month, day);
  }

  // Weekday names resolve to the next occurrence strictly after today.
  const weekday = new RegExp(`\\b${WEEKDAY_RE}\\b`).exec(text);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]];
    let delta = (target - weekdayOf(today) + 7) % 7;
    if (delta === 0) delta = 7;
    return { date: ymd(addDays(today, delta)), invalid: false, mentioned: true };
  }

  // "el 26": the next day-of-month strictly after today.
  const bareDay = /\bel\s+(\d{1,2})\b/.exec(text);
  if (bareDay) {
    const day = Number(bareDay[1]);
    const nextMonth = day <= nowDay;
    const year = nextMonth && nowMonth === 12 ? nowYear + 1 : nowYear;
    const month = nextMonth ? (nowMonth === 12 ? 1 : nowMonth + 1) : nowMonth;
    return build(year, month, day);
  }

  return { date: null, invalid: false, mentioned: false };
}

/** Sundays, closed dates and Saturday afternoons cannot be booked. */
const bookableDate = (date, timeWindow, context) => {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const weekday = weekdayOf(ms);
  if (weekday === 0) return false;
  if (Array.isArray(context?.closed_dates) && context.closed_dates.includes(date)) return false;
  if (weekday === 6 && timeWindow === "afternoon") return false;
  return true;
};

// ---------------------------------------------------------------------------
// rules: parser
// ---------------------------------------------------------------------------

const REPLIES = {
  book: "Listo, te reservo el turno.",
  availability: "Te cuento los turnos disponibles.",
  cancel: "Listo, cancelo el turno.",
  reschedule: "Listo, lo cambio de fecha.",
  clarify: "¿Me pasás la especialidad, la fecha o el código del turno?",
  escalate: "Esto puede ser una urgencia: llamá al 107 o andá a la guardia ahora.",
  decline: "No puedo dar consejo médico, pero sí puedo ayudarte con un turno.",
};

/**
 * Deterministic Spanish intake parser. Reads only the message and the clinic
 * calendar, never `expect`.
 */
export function rulesOutput(testCase, options = {}) {
  const context = options.context ?? loadContext();
  const message = testCase?.message ?? "";
  const text = normalizeText(message);

  const specialties = detectSpecialties(text);
  const specialty = specialties.length === 1 ? specialties[0] : null;

  const validCode = VALID_CODE_RE.exec(text);
  const bookingCode = validCode ? `RS-${validCode[1]}` : null;

  const resolved = resolveDate(message, context);
  const date = resolved.date;
  const timeWindowHint = detectTimeWindow(text);

  const base = {
    specialty,
    date: null,
    time_window: null,
    booking_code: bookingCode,
    reply: REPLIES.clarify,
  };

  // 1. Emergencies have priority over anything else in the message.
  if (EMERGENCY_RE.test(text)) {
    return { ...base, action: "escalate", reply: REPLIES.escalate };
  }

  // 2. Requests for medical advice are declined.
  if (ADVICE_RE.test(text)) {
    return { ...base, action: "decline", reply: REPLIES.decline };
  }

  // 3. Cancellations need the booking code; without it, ask for it.
  if (CANCEL_RE.test(text)) {
    if (!bookingCode) return { ...base, action: "clarify" };
    return { ...base, action: "cancel", reply: REPLIES.cancel };
  }

  // 4. Rescheduling needs both the code and a date.
  if (RESCHEDULE_RE.test(text)) {
    if (!bookingCode || !date) return { ...base, action: "clarify" };
    return { ...base, action: "reschedule", date, reply: REPLIES.reschedule };
  }

  // 5. Availability questions need a specialty.
  if (AVAILABILITY_RE.test(text)) {
    if (!specialty) return { ...base, action: "clarify" };
    return {
      ...base,
      action: "availability",
      date,
      time_window: timeWindowHint ?? "any",
      reply: REPLIES.availability,
    };
  }

  // 6. Booking needs a specialty plus a booking cue, and a date the clinic can take.
  if (specialty && hasBookCue(text)) {
    const usable = !resolved.invalid && (date === null || bookableDate(date, timeWindowHint, context));
    if (!usable) return { ...base, action: "clarify" };
    return {
      ...base,
      action: "book",
      date,
      time_window: timeWindowHint ?? "any",
      reply: REPLIES.book,
    };
  }

  // 7. Nothing actionable: ask for the missing data.
  return { ...base, action: "clarify" };
}

/**
 * @param {"oracle"|"null"|"majority"|"rules"} kind
 * @param {{id?: string, message?: string, expect?: object, category?: string}} testCase
 * @param {{context?: object}} [options]
 */
export function baselineCall(kind, testCase, options = {}) {
  const shape = PROVIDER_DEFAULTS();

  switch (kind) {
    case "oracle":
      return {
        text: JSON.stringify(oracleOutput(testCase)),
        ...shape,
        served_model: "baseline/oracle",
      };
    case "null":
      return {
        text: "",
        ...shape,
        served_model: "baseline/null",
      };
    case "majority":
      return {
        text: JSON.stringify(majorityOutput()),
        ...shape,
        served_model: "baseline/majority",
      };
    case "rules":
      return {
        text: JSON.stringify(rulesOutput(testCase, options)),
        ...shape,
        served_model: "baseline/rules",
      };
    default:
      throw new Error(`unknown baseline kind: ${String(kind)}`);
  }
}

export { oracleOutput, majorityOutput };
