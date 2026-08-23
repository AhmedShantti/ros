/**
 * Weekly local-time recurrence v1 — ratified as **P0-2**, implementing
 * `FR-MNU-022` ("time-based pricing with recurring schedules (e.g. weekdays
 * 15:00–18:00), evaluated in the branch's timezone").
 *
 * P0-2 ratified the SHAPE and the SEMANTICS; field names, validation rules and
 * the empty-day-set case were left to implementation, and are settled here.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *   { "v": 1, "days": ["mon","tue",…], "from": "15:00", "to": "18:00" }
 *
 * ── SEMANTICS (ratified, not re-decided here) ───────────────────────────────
 *   - evaluated in the BRANCH timezone (`org.branches.timezone`);
 *   - `to <= from` wraps past midnight — the identical convention already
 *     ratified in ADR 0008 D-04 for `org.operating_hours`, so no new semantic;
 *   - DST is handled by evaluating WALL-CLOCK time in the branch zone, never by
 *     pre-expanding to UTC;
 *   - RFC 5545 / RRULE is explicitly NOT adopted.
 *
 * ── BOUNDARIES ──────────────────────────────────────────────────────────────
 * Half-open `[from, to)`, consistent with **P0-1**: the start minute is inside
 * the window, the end minute is outside it. For a wrapping window the same rule
 * applies across the midnight boundary.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Pure. The evaluation instant is always supplied; nothing reads `Date.now()`,
 * the server timezone, or any locale. Wall-clock extraction uses `Intl` with an
 * explicit IANA zone and the `en-CA` calendar (stable ISO-ish field order), so
 * the result depends only on (instant, zone) — the property BR-FIN-005 /
 * FR-OFF-050 require of anything that must one day agree with a Dart client.
 */

/** Canonical weekday tokens. Index matches `Date#getUTCDay` (0 = Sunday). */
export const WEEKDAYS = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** The parsed, validated P0-2 rule. */
export interface WeeklyRecurrence {
  readonly version: 1;
  /** Non-empty, de-duplicated, canonical order. */
  readonly days: readonly Weekday[];
  /** Minutes from local midnight, 0…1439. */
  readonly fromMinutes: number;
  /** Minutes from local midnight, 0…1439. `<= fromMinutes` means it wraps. */
  readonly toMinutes: number;
}

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseLocalTime(value: unknown, field: string): number {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new RecurrenceError(
      `recurrence.${field} must be a local time "HH:MM" (00:00–23:59), got ${JSON.stringify(value)}.`,
    );
  }
  const [hh, mm] = value.split(':');
  return Number(hh) * 60 + Number(mm);
}

/**
 * Validate and parse a stored `recurrence_rule` JSON value.
 *
 * Deliberately strict — an unrecognised shape is rejected rather than ignored,
 * because silently treating a malformed rule as "no recurrence" would make a
 * price apply at times the operator never configured.
 */
export function parseRecurrence(raw: unknown): WeeklyRecurrence {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new RecurrenceError('recurrence rule must be a JSON object.');
  }
  const rule = raw as Record<string, unknown>;

  if (rule.v !== 1) {
    throw new RecurrenceError(
      `Unsupported recurrence version ${JSON.stringify(rule.v)}; only v1 (weekly local time) is implemented.`,
    );
  }

  if (!Array.isArray(rule.days)) {
    throw new RecurrenceError('recurrence.days must be an array of weekdays.');
  }
  const seen = new Set<Weekday>();
  for (const day of rule.days) {
    if (typeof day !== 'string' || !WEEKDAYS.includes(day as Weekday)) {
      throw new RecurrenceError(
        `recurrence.days contains an invalid weekday ${JSON.stringify(day)}; expected one of ${WEEKDAYS.join(', ')}.`,
      );
    }
    seen.add(day as Weekday);
  }
  // Empty day set: settled here as INVALID. A rule that can never match would
  // silently disable a price list, which is indistinguishable from a
  // misconfiguration; rejecting it surfaces the mistake at write time.
  if (seen.size === 0) {
    throw new RecurrenceError(
      'recurrence.days must list at least one weekday.',
    );
  }

  const fromMinutes = parseLocalTime(rule.from, 'from');
  const toMinutes = parseLocalTime(rule.to, 'to');

  return {
    version: 1,
    days: WEEKDAYS.filter((d) => seen.has(d)),
    fromMinutes,
    toMinutes,
  };
}

/** True when the value is a well-formed v1 rule. Never throws. */
export function isValidRecurrence(raw: unknown): boolean {
  try {
    parseRecurrence(raw);
    return true;
  } catch {
    return false;
  }
}

/** Branch-local wall-clock fields for an instant. */
export interface LocalWallClock {
  /** 0 = Sunday, matching {@link WEEKDAYS}. */
  readonly weekdayIndex: number;
  /** Minutes from local midnight. */
  readonly minutes: number;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new RecurrenceError(`Unknown IANA timezone: ${timeZone}.`);
    }
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_LOOKUP: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

/**
 * Project an absolute instant onto branch-local wall-clock fields.
 *
 * This is the only place a timezone is consulted, and it uses the supplied IANA
 * zone — never the server's. DST is therefore handled by construction: the same
 * instant yields the offset actually in force in that zone on that date.
 */
export function toLocalWallClock(at: Date, timeZone: string): LocalWallClock {
  const parts = formatterFor(timeZone).formatToParts(at);
  let weekday: string | undefined;
  let hour: string | undefined;
  let minute: string | undefined;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    else if (part.type === 'hour') hour = part.value;
    else if (part.type === 'minute') minute = part.value;
  }
  const weekdayIndex =
    weekday === undefined ? undefined : WEEKDAY_LOOKUP[weekday];
  if (
    weekdayIndex === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    throw new RecurrenceError(
      `Could not derive local wall-clock fields for timezone ${timeZone}.`,
    );
  }
  // `hourCycle: 'h23'` still renders midnight as "24" in some ICU versions.
  const hours = Number(hour) % 24;
  return { weekdayIndex, minutes: hours * 60 + Number(minute) };
}

/**
 * Is the rule active at `at`, in `timeZone`?
 *
 * Non-wrapping window (`from < to`): the local weekday must be listed and the
 * local time must be in `[from, to)`.
 *
 * Wrapping window (`to <= from`, ADR 0008 D-04 convention): the window runs from
 * `from` on a listed day, through midnight, to `to` on the following day. So the
 * instant matches when EITHER the local day is listed and the time is `>= from`,
 * OR the PREVIOUS local day is listed and the time is `< to`. `from === to` is
 * treated as wrapping and therefore covers the full 24 hours from `from` — it is
 * a degenerate but internally consistent case, not a special rule.
 */
export function recurrenceMatchesAt(
  rule: WeeklyRecurrence,
  at: Date,
  timeZone: string,
): boolean {
  const { weekdayIndex, minutes } = toLocalWallClock(at, timeZone);
  const today = WEEKDAYS[weekdayIndex];
  const yesterday = WEEKDAYS[(weekdayIndex + 6) % 7];

  if (rule.fromMinutes < rule.toMinutes) {
    return (
      rule.days.includes(today) &&
      minutes >= rule.fromMinutes &&
      minutes < rule.toMinutes
    );
  }

  // Wrapping (or full-day) window.
  const startedToday = rule.days.includes(today) && minutes >= rule.fromMinutes;
  const startedYesterday =
    rule.days.includes(yesterday) && minutes < rule.toMinutes;
  return startedToday || startedYesterday;
}

/**
 * Convenience for the resolver: parse and evaluate in one step.
 *
 * Throws {@link RecurrenceError} on a malformed rule — the caller decides
 * whether that is a 400 (write path) or an explicit resolution failure.
 */
export function recurrenceApplies(
  raw: unknown,
  at: Date,
  timeZone: string,
): boolean {
  return recurrenceMatchesAt(parseRecurrence(raw), at, timeZone);
}
