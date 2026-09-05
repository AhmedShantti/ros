/**
 * Pure month arithmetic for the partition-lifecycle job (FR-DR-002). No
 * database, no Prisma, no I/O — every function here is a straight computation
 * over UTC calendar months, unit-testable in isolation.
 *
 * ── WHY UTC AND NOT A TENANT ZONE ───────────────────────────────────────────
 * Unlike a business-facing scheduled job (e.g. Inventory's daily
 * reconciliation), partition maintenance has no "business day" and no tenant.
 * A partition boundary is a property of the PHYSICAL table, shared by every
 * tenant that writes to it, so there is exactly one clock: UTC. Anchoring to a
 * tenant's zone would not change which months need partitions — every zone
 * agrees on which UTC month "now" falls in to within a few hours, which is
 * irrelevant at monthly granularity — and would only reintroduce a dependency
 * this job does not need.
 */

/** A calendar month, UTC. `month` is 1-12 (not the 0-11 JS convention). */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/** `2026-09` → sorts and compares correctly as a plain string. */
export function yearMonthKey(ym: YearMonth): string {
  return `${ym.year.toString().padStart(4, '0')}-${ym.month.toString().padStart(2, '0')}`;
}

export function addMonths(ym: YearMonth, delta: number): YearMonth {
  const zeroBased = ym.year * 12 + (ym.month - 1) + delta;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return { year, month };
}

export function yearMonthOf(instant: Date): YearMonth {
  return { year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1 };
}

/**
 * The months that MUST have a partition, given `now` and a required
 * look-ahead horizon in whole months.
 *
 * FR-DR-002: "Partitions SHALL be created automatically at least 3 months in
 * advance." The SRS states a minimum horizon, not an hour or a day the
 * refresh must happen — this is the same class of implementation-level
 * operationalisation the reconciliation job made explicit for "daily" (see
 * `daily-reconciliation.job.ts`). Read literally: "at least 3 months in
 * advance" means a partition covering (current month + 3) must exist at all
 * times, and — because a gap is forbidden regardless — so must every month
 * between now and then. `horizonMonths = 3` therefore yields the CURRENT
 * month plus the next three: four months' worth of partitions, inclusive of
 * both ends.
 */
export function requiredMonths(now: Date, horizonMonths: number): YearMonth[] {
  const current = yearMonthOf(now);
  const months: YearMonth[] = [];
  for (let i = 0; i <= horizonMonths; i += 1) {
    months.push(addMonths(current, i));
  }
  return months;
}

/** `stock_movements_2026_09` — byte-identical to the naming already used by
 * every partition created in the foundation migrations. */
export function partitionTableName(baseTable: string, ym: YearMonth): string {
  return `${baseTable}_${ym.year.toString().padStart(4, '0')}_${ym.month
    .toString()
    .padStart(2, '0')}`;
}

/** The `FOR VALUES FROM (...) TO (...)` bounds for one calendar month, as
 * ISO date literals — the same `'YYYY-MM-01'` style the foundation migrations
 * use, which PostgreSQL casts correctly whether the partition key column is
 * `DATE` (`business_day`) or `TIMESTAMPTZ` (`occurred_at`). Correct across
 * every month/year boundary, including December → January and every leap
 * year, because it is delegated entirely to `addMonths`' integer arithmetic —
 * there is no calendar-day computation anywhere in this function to get
 * wrong. */
export function partitionBounds(ym: YearMonth): { from: string; to: string } {
  const next = addMonths(ym, 1);
  const iso = (y: YearMonth): string =>
    `${y.year.toString().padStart(4, '0')}-${y.month.toString().padStart(2, '0')}-01`;
  return { from: iso(ym), to: iso(next) };
}
