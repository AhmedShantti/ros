/**
 * Time-of-day helpers for `org.operating_hours` (PostgreSQL `TIME`, surfaced by
 * Prisma as a `Date` anchored at 1970-01-01 UTC).
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export const TIME_OF_DAY_PATTERN = TIME_PATTERN;

/** Parse `HH:MM` / `HH:MM:SS` into the UTC-anchored Date Prisma expects. */
export function parseTimeOfDay(value: string): Date {
  if (!TIME_PATTERN.test(value)) {
    throw new Error(`Invalid time-of-day: ${value}`);
  }
  const [hh, mm, ss = '00'] = value.split(':');
  return new Date(Date.UTC(1970, 0, 1, Number(hh), Number(mm), Number(ss)));
}

/** Render a stored TIME back as `HH:MM:SS`. */
export function formatTimeOfDay(value: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(
    value.getUTCSeconds(),
  )}`;
}

/** Minutes since midnight. */
export function minutesOfDay(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

export interface Interval {
  opensAt: Date;
  closesAt: Date;
}

/**
 * Normalise an interval to `[start, end)` in minutes, extending past 1440 when
 * it crosses midnight.
 *
 * Overnight operation is SRS-mandated, not inferred: the glossary defines the
 * business day as "an operational day, which may not align with the calendar
 * day. A branch closing at 03:00 attributes those sales to the previous business
 * day." So `closesAt <= opensAt` means the interval wraps past midnight.
 */
export function toRange(interval: Interval): [number, number] {
  const start = minutesOfDay(interval.opensAt);
  const rawEnd = minutesOfDay(interval.closesAt);
  const end = rawEnd <= start ? rawEnd + 24 * 60 : rawEnd;
  return [start, end];
}

/**
 * True when two intervals on the SAME weekday overlap.
 *
 * ADR 0008 D-04: multiple intervals per weekday are permitted (split shifts such
 * as 11:00–15:00 and 18:00–23:00); *overlapping* intervals are rejected. The
 * comparison is deliberately scoped to one weekday — whether an overnight
 * interval conflicts with the following day's morning interval is NOT defined by
 * the SRS, so no policy is invented for it.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  const [aStart, aEnd] = toRange(a);
  const [bStart, bEnd] = toRange(b);
  return aStart < bEnd && bStart < aEnd;
}
