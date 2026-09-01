/**
 * Business-day resolution — FR-FIN-024 [M].
 *
 * "The System SHALL support a configurable business-day boundary per branch
 * (e.g. 04:00), so that late-night trading is attributed to the correct
 * operating day." The approved SQL puts that boundary on
 * `org.operating_hours.business_day_cutover TIME`, defaulting to `'00:00'`.
 *
 * The business day is SERVER-DERIVED. A terminal supplies the instant it
 * believes a sale happened (`origin_device_time`), but never the day the sale is
 * booked to: `sales.orders` is RANGE-partitioned by `business_day` and every Z
 * report keys on it, so a client-chosen value would let a device file revenue
 * into the wrong day and the wrong partition.
 *
 * ── WHICH DAY'S CUTOVER APPLIES ─────────────────────────────────────────────
 * `business_day_cutover` sits on a per-weekday operating-hours row, so a branch
 * may roll over at a different hour on different days. The boundary consulted is
 * the one belonging to the LOCAL CALENDAR DATE the clock currently shows —
 * "when the business day rolls over" is a property of the day being rolled INTO.
 * A sale at 02:00 on a Saturday whose cutover is 04:00 therefore belongs to
 * Friday. A branch with no operating-hours row for that weekday uses `00:00`,
 * which is the column default and means "the business day is the calendar day".
 *
 * Everything is integer arithmetic on wall-clock fields obtained from the IANA
 * zone, so DST transitions are handled by construction and the server's own
 * timezone never participates.
 */

/** Raised when a branch's timezone cannot be interpreted. */
export class BusinessDayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessDayError';
  }
}

interface LocalDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** 0 = Sunday, matching `org.operating_hours.day_of_week`. */
  readonly weekdayIndex: number;
  /** Minutes since local midnight. */
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
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new BusinessDayError(`Unknown IANA timezone: ${timeZone}.`);
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

/** Project an instant onto branch-local calendar and wall-clock fields. */
export function toLocalDateTime(at: Date, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(at);
  const field: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) field[part.type] = part.value;

  const weekdayIndex =
    field.weekday === undefined ? undefined : WEEKDAY_LOOKUP[field.weekday];
  if (
    field.year === undefined ||
    field.month === undefined ||
    field.day === undefined ||
    field.hour === undefined ||
    field.minute === undefined ||
    weekdayIndex === undefined
  ) {
    throw new BusinessDayError(
      `Could not derive local calendar fields for timezone ${timeZone}.`,
    );
  }
  return {
    year: Number(field.year),
    month: Number(field.month),
    day: Number(field.day),
    weekdayIndex,
    // `hourCycle: 'h23'` still renders midnight as "24" in some ICU versions.
    minutes: (Number(field.hour) % 24) * 60 + Number(field.minute),
  };
}

/** Parse a `TIME` value into minutes since midnight. Accepts a `Date` (Prisma
 *  renders `time` columns as a Date on 1970-01-01 UTC) or an `HH:MM[:SS]` string. */
export function cutoverMinutes(
  value: Date | string | null | undefined,
): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) {
    return value.getUTCHours() * 60 + value.getUTCMinutes();
  }
  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  if (!match) {
    throw new BusinessDayError(`Not a TIME value: ${JSON.stringify(value)}.`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Build the `cutoverFor` lookup {@link resolveBusinessDay} needs from a
 * branch's `org.operating_hours` rows. A weekday with no row uses `0`
 * (midnight), matching the column default — "the business day is the
 * calendar day". This is the ONE place this lookup is built; `OrdersService`
 * (order creation, FR-FIN-024) and Sales' `DAILY_TRADING_SALES_QUERY`
 * (reporting's `currentBusinessDay`/future-day check) both import it from
 * here rather than each keeping their own copy — a second copy would risk
 * silently diverging from the algorithm that actually decides which
 * partition an Order lands in.
 */
export function cutoverLookup(
  hours: readonly { dayOfWeek: number; businessDayCutover: Date }[],
): (weekdayIndex: number) => number {
  const byWeekday = new Map<number, number>();
  for (const row of hours) {
    byWeekday.set(row.dayOfWeek, cutoverMinutes(row.businessDayCutover));
  }
  return (weekdayIndex) => byWeekday.get(weekdayIndex) ?? 0;
}

/**
 * Resolve the business day for an instant at a branch.
 *
 * @param at        the instant to attribute (server clock, or the device time
 *                  the caller has decided to trust).
 * @param timeZone  the branch's IANA zone.
 * @param cutoverFor minutes-since-midnight boundary for a local weekday index.
 * @returns UTC midnight of the resulting date — the exact value a `DATE` column
 *          round-trips, and what the partition constraint is evaluated against.
 */
export function resolveBusinessDay(
  at: Date,
  timeZone: string,
  cutoverFor: (weekdayIndex: number) => number,
): Date {
  const local = toLocalDateTime(at, timeZone);
  const boundary = cutoverFor(local.weekdayIndex);
  if (!Number.isInteger(boundary) || boundary < 0 || boundary >= 24 * 60) {
    throw new BusinessDayError(
      `Business-day cutover must be a minute of the day, got ${boundary}.`,
    );
  }

  const date = Date.UTC(local.year, local.month - 1, local.day);
  // Before the boundary the branch is still trading yesterday's day.
  const shifted = local.minutes < boundary ? date - 86_400_000 : date;
  return new Date(shifted);
}
