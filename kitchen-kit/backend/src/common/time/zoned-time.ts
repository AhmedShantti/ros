/**
 * Zoned wall-clock arithmetic for SCHEDULING — SCHED-1.
 *
 * ── WHY THIS EXISTS ALONGSIDE `sales/orders/business-day.ts` ────────────────
 * Sales owns `resolveBusinessDay`: given an INSTANT and a branch, which
 * business day is it? That is the forward direction, and it stays exactly where
 * it is — this file does not re-implement, re-export or duplicate the
 * business-day cutover algorithm, the weekday lookup, or anything that decides
 * which partition an Order lands in.
 *
 * A scheduler needs the INVERSE, which nothing in this repository provides:
 * given a LOCAL WALL-CLOCK SLOT ("03:00 local, on 2026-09-03, in Africa/Cairo"),
 * which UTC instant is that? Only the ~25 lines of `Intl.DateTimeFormat`
 * projection are shared between the two directions, and Sales' copy cannot be
 * imported here: `business-day.ts` is a PRIVATE file of the Sales module and
 * `module-boundaries.spec.ts` forbids reaching into another module's internals
 * (the alternative would be a new `KNOWN_DEVIATIONS` entry for a pure date
 * utility, which is worse than a stdlib idiom appearing twice).
 *
 * ── WHY LOCAL SLOTS, NOT UTC INSTANTS, ARE THE SCHEDULING IDENTITY ─────────
 * "Daily at 03:00" is a statement about a wall clock, not about UTC. Under DST
 * the two disagree twice a year, and each disagreement has exactly one honest
 * answer:
 *
 *   REPEATED local time (autumn fall-back). 02:30 happens twice. Scheduling on
 *   the instant would run a once-a-day job twice. This module resolves the
 *   slot to the EARLIER of the two instants, and the occurrence key stays the
 *   local slot, so the database's own primary key makes it once.
 *
 *   SKIPPED local time (spring forward). 02:30 never happens. Scheduling on the
 *   instant would silently skip a required business occurrence. This module
 *   resolves the slot to the TRANSITION INSTANT — the first moment at or after
 *   which the local clock has passed the requested time — so the occurrence
 *   still happens, once, at the earliest honest moment.
 *
 * Both answers are the SAME rule: `instantForLocalSlot` returns the EARLIEST UTC
 * instant whose local projection is at or after the requested slot. That rule is
 * total (it always has an answer, in both DST directions), and deterministic —
 * no clock, no locale, and no server timezone participates in it. See that
 * function's own docblock for why the rule cannot be implemented as a plain
 * binary search: the predicate is not monotone across a fall-back.
 *
 * ── NO SERVER-LOCAL TIME, ANYWHERE ─────────────────────────────────────────
 * Every function here takes an explicit IANA zone. Nothing reads
 * `process.env.TZ`, `new Date().getTimezoneOffset()`, or any non-UTC method on
 * `Date`. Moving a deployment between regions cannot move a tenant's schedule.
 */

/** Raised when a zone cannot be interpreted or a slot is malformed. */
export class ZonedTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZonedTimeError';
  }
}

/** An instant projected onto a zone's calendar and wall clock. */
export interface ZonedWallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Minutes since local midnight, 0..1439. */
  readonly minutes: number;
}

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new ZonedTimeError(`Unknown IANA timezone: ${timeZone}.`);
    }
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

/** Project an instant onto a zone's calendar date and wall clock. */
export function projectToZone(at: Date, timeZone: string): ZonedWallClock {
  const field: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    field[part.type] = part.value;
  }
  if (
    field.year === undefined ||
    field.month === undefined ||
    field.day === undefined ||
    field.hour === undefined ||
    field.minute === undefined
  ) {
    throw new ZonedTimeError(
      `Could not derive local calendar fields for timezone ${timeZone}.`,
    );
  }
  return {
    year: Number(field.year),
    month: Number(field.month),
    day: Number(field.day),
    // `hourCycle: 'h23'` still renders midnight as "24" in some ICU versions.
    minutes: (Number(field.hour) % 24) * 60 + Number(field.minute),
  };
}

/** A local scheduling slot: a local calendar date plus minutes-since-midnight. */
export interface LocalSlot {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minutes: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function assertMinuteOfDay(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new ZonedTimeError(
      `Local time of day must be a minute of the day (0..1439), got ${minutes}.`,
    );
  }
}

/**
 * Render a slot as its canonical, DATABASE-STORED occurrence key:
 * `YYYY-MM-DDTHH:MM`. Fixed width, lexicographically ordered, and derivable
 * identically by every instance without coordination.
 */
export function localSlotKey(slot: LocalSlot): string {
  assertMinuteOfDay(slot.minutes);
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return (
    `${p(slot.year, 4)}-${p(slot.month, 2)}-${p(slot.day, 2)}` +
    `T${p(Math.floor(slot.minutes / 60), 2)}:${p(slot.minutes % 60, 2)}`
  );
}

/** Parse a canonical occurrence key back into its slot. */
export function parseLocalSlotKey(key: string): LocalSlot {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key);
  if (!m) {
    throw new ZonedTimeError(`Not a canonical local slot key: ${key}.`);
  }
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    minutes: Number(m[4]) * 60 + Number(m[5]),
  };
}

/** The slot a projected wall clock represents, as a comparable UTC-epoch number. */
function wallClockAsEpoch(at: ZonedWallClock): number {
  return Date.UTC(at.year, at.month - 1, at.day) + at.minutes * MINUTE_MS;
}

/**
 * The zone's UTC offset at an instant, in milliseconds, derived by projection
 * rather than by parsing an offset string. Positive is east of Greenwich.
 */
function offsetMsAt(epochMs: number, timeZone: string): number {
  return wallClockAsEpoch(projectToZone(new Date(epochMs), timeZone)) - epochMs;
}

/**
 * THE inverse of {@link projectToZone}: the earliest UTC instant whose
 * projection into `timeZone` is at or after `slot`.
 *
 * ── THE THREE CASES, AND WHY THIS IS NOT A BINARY SEARCH OVER THE WHOLE DAY ──
 * "Has the local clock reached the slot yet?" is NOT monotone in UTC across a
 * DST fall-back — the local clock goes backwards — so a naive binary search
 * over the day converges on whichever crossing its midpoints happen to hit.
 * Instead the answer is constructed from the at most TWO offsets in play around
 * the slot, sampled a day either side of it (no real transition is further from
 * the affected local date than that):
 *
 *   NORMAL DAY   one offset, one candidate, and it always projects back to the
 *                slot exactly.
 *
 *   REPEATED     (autumn fall-back) both candidates project back to the slot —
 *   LOCAL TIME   the same wall clock really does happen twice. The EARLIER is
 *                returned, so a once-a-day job runs at the first 01:30, not the
 *                second, and the occurrence key (which is the local slot) makes
 *                the database reject any attempt at a second row regardless.
 *
 *   SKIPPED      (spring forward) NEITHER candidate projects back to the slot —
 *   LOCAL TIME   that wall clock never happens. The occurrence is NOT skipped;
 *                the transition instant is returned, i.e. the first moment the
 *                local clock has passed the requested time. Inside the bracket
 *                between the two candidates the offset changes exactly once, so
 *                the predicate IS monotone there and a bounded binary search
 *                finds that instant exactly.
 *
 * Minute granularity is exact, not an approximation: every IANA offset and every
 * DST transition in the tz database is a whole number of minutes, and scheduling
 * slots are themselves minute-granular.
 */
export function instantForLocalSlot(slot: LocalSlot, timeZone: string): Date {
  assertMinuteOfDay(slot.minutes);
  const naive =
    Date.UTC(slot.year, slot.month - 1, slot.day) + slot.minutes * MINUTE_MS;
  if (!Number.isFinite(naive)) {
    throw new ZonedTimeError(
      `Not a representable local slot: ${localSlotKey(slot)}.`,
    );
  }

  const offsetBefore = offsetMsAt(naive - DAY_MS, timeZone);
  const offsetAfter = offsetMsAt(naive + DAY_MS, timeZone);
  const candidates =
    offsetBefore === offsetAfter
      ? [naive - offsetBefore]
      : [naive - offsetBefore, naive - offsetAfter];

  const exact = candidates.filter(
    (c) => wallClockAsEpoch(projectToZone(new Date(c), timeZone)) === naive,
  );
  if (exact.length > 0) {
    return new Date(Math.min(...exact));
  }

  // Skipped local time. The transition lies strictly between the two
  // candidates; bracket it and narrow to the minute.
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  const reached = (t: number): boolean =>
    wallClockAsEpoch(projectToZone(new Date(t), timeZone)) >= naive;
  if (reached(lo) || !reached(hi)) {
    throw new ZonedTimeError(
      `Timezone ${timeZone} reports an offset pattern around ` +
        `${localSlotKey(slot)} that cannot be resolved to an instant.`,
    );
  }
  // Invariant: local(lo) < slot <= local(hi).
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
    if (mid === lo) break;
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/**
 * The daily slots at `localTimeOfDay` in `timeZone` that are already DUE at
 * `now`, most recent first, capped at `limit`.
 *
 * This is the whole cadence engine for `daily`, and it is deliberately the only
 * cadence: the SRS requirements this substrate serves say "daily" and "at a
 * configurable time", never a cron expression, and inventing a cron dialect
 * would be inventing semantics no source states.
 *
 * `limit` is the BOUNDED CATCH-UP horizon. A scheduler that has been down for a
 * week returns at most `limit` slots, so it cannot produce a catch-up storm;
 * the horizon is durable, per-tenant configuration rather than a hidden
 * constant, so anything older is an explicit operational bound, not a silent
 * skip.
 */
export function dueDailySlots(
  now: Date,
  timeZone: string,
  localTimeOfDay: number,
  limit: number,
): { slot: LocalSlot; key: string; scheduledFor: Date }[] {
  assertMinuteOfDay(localTimeOfDay);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ZonedTimeError(
      `Catch-up limit must be a positive integer, got ${limit}.`,
    );
  }

  const local = projectToZone(now, timeZone);
  // Walk back from today's local date. Today's slot may not be due yet (the
  // local clock has not reached it), in which case the first DUE slot is
  // yesterday's — the loop simply skips any candidate whose instant is in the
  // future, which needs no separate case.
  const out: { slot: LocalSlot; key: string; scheduledFor: Date }[] = [];
  const cursor = Date.UTC(local.year, local.month - 1, local.day);
  for (let back = 0; back < limit + 1 && out.length < limit; back += 1) {
    const d = new Date(cursor - back * DAY_MS);
    const slot: LocalSlot = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      minutes: localTimeOfDay,
    };
    const scheduledFor = instantForLocalSlot(slot, timeZone);
    if (scheduledFor.getTime() > now.getTime()) continue;
    out.push({ slot, key: localSlotKey(slot), scheduledFor });
  }
  return out;
}
