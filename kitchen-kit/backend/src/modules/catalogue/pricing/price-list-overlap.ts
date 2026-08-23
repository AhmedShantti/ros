/**
 * PriceList overlap invariant — SRS §7.3 aggregate #10.
 *
 *   PriceList | Catalogue | PriceEntries, ValidityWindow
 *   Key invariant: "No overlapping windows of same priority for same scope"
 *
 * Pure logic, no database and no clock, mirroring the existing
 * `org/operating-hours/time-of-day.ts` overlap helper.
 *
 * This is the FRIENDLY half of the enforcement: it lets the service return a
 * clear 409 naming the conflicting list. The ACTUAL guarantee is the database
 * exclusion constraint `ex_price_list_no_overlap` (migration
 * 20260819120000_price_list_no_overlap), because an application pre-check alone
 * is not concurrency safe — two simultaneous writers can both see no conflict.
 * Both layers use the identical key and the identical half-open window test, so
 * they cannot disagree.
 *
 * KEY COMPOSITION — see the migration for the full reasoning. In short: scope is
 * (scope_type, scope_id) so Branch X and Branch Y are different scopes; NULL
 * scope_id (tenant scope) is folded to a sentinel so two tenant-scope lists do
 * compare; `order_type` is NOT part of the key, because FR-MNU-020 enumerates
 * scope without it and no ratified source makes it part of scope;
 * `recurrence_rule` is excluded because its grammar is undefined and must not be
 * guessed.
 */

/** The validity window half of a price list. `null` means unbounded. */
export interface ValidityWindow {
  readonly validFrom: Date | null;
  readonly validTo: Date | null;
}

/**
 * Everything that makes two price lists occupy the same invariant slot.
 *
 * `orderType` is deliberately absent: SRS §7.3 #10 conditions the invariant on
 * scope, priority and window only, and FR-MNU-020 does not count order type as
 * scope. Two order-type-specific lists sharing a scope, priority and window are
 * therefore a violation — they must differ in priority.
 */
export interface OverlapKey extends ValidityWindow {
  readonly scopeType: string;
  /** `null` for tenant scope. */
  readonly scopeId: string | null;
  readonly priority: number;
}

/**
 * Mirrors the migration's `COALESCE(scope_id, <nil uuid>)`.
 *
 * In practice `PriceListsService.assertScope` stores the acting tenant's own id
 * for `tenant` scope rather than NULL, so this sentinel is a belt-and-braces
 * match for the database expression rather than a path exercised by the current
 * write surface.
 */
const NIL_SCOPE = '00000000-0000-0000-0000-000000000000';

/** PostgreSQL `exclusion_violation`. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Did this error come from the `ex_price_list_no_overlap` exclusion constraint?
 *
 * Prisma surfaces an exclusion violation as an unknown/raw error rather than a
 * typed `P2002` (which covers unique constraints only), so the PostgreSQL SQLSTATE
 * is matched instead. Used to turn the concurrency-race loser into the same 409
 * the pre-check returns, rather than a 500.
 */
export function isExclusionViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as {
    code?: unknown;
    message?: unknown;
    meta?: unknown;
  };
  if (candidate.code === EXCLUSION_VIOLATION) {
    return true;
  }
  const message =
    typeof candidate.message === 'string' ? candidate.message : '';
  const haystack = `${message} ${JSON.stringify(candidate.meta ?? {})}`;
  return (
    haystack.includes(EXCLUSION_VIOLATION) ||
    haystack.includes('ex_price_list_no_overlap')
  );
}

/**
 * Do two price lists target the same scope at the same priority?
 *
 * Two `branch`-scoped lists pointing at different branches are NOT the same
 * scope, even though both are `branch`. Order type is not consulted — see the
 * note on {@link OverlapKey}.
 */
export function sameInvariantSlot(a: OverlapKey, b: OverlapKey): boolean {
  return (
    a.scopeType === b.scopeType &&
    (a.scopeId ?? NIL_SCOPE) === (b.scopeId ?? NIL_SCOPE) &&
    a.priority === b.priority
  );
}

/**
 * Do two validity windows overlap?
 *
 * Half-open `[validFrom, validTo)` with `null` as an infinite bound, matching
 * PostgreSQL's `tstzrange(valid_from, valid_to)` exactly. Two windows that merely
 * touch — one ending at the instant the next begins — do NOT overlap.
 *
 * The SRS does not state boundary semantics; half-open is recorded as an
 * implementation convention, consistent with the resolver's eligibility test.
 */
export function windowsOverlap(a: ValidityWindow, b: ValidityWindow): boolean {
  const startsBeforeOtherEnds =
    a.validFrom === null || b.validTo === null || a.validFrom < b.validTo;
  const otherStartsBeforeThisEnds =
    b.validFrom === null || a.validTo === null || b.validFrom < a.validTo;
  return startsBeforeOtherEnds && otherStartsBeforeThisEnds;
}

/** True when the two lists together violate §7.3 #10. */
export function violatesOverlapInvariant(
  a: OverlapKey,
  b: OverlapKey,
): boolean {
  return sameInvariantSlot(a, b) && windowsOverlap(a, b);
}

/**
 * First existing list that a candidate would conflict with, or `null`.
 *
 * Order-independent: any conflicting member is a valid answer because a
 * conflict blocks the write either way, and the database constraint is the
 * authority on whether the write succeeds.
 */
export function findConflicting<T extends OverlapKey>(
  candidate: OverlapKey,
  existing: readonly T[],
): T | null {
  return existing.find((e) => violatesOverlapInvariant(candidate, e)) ?? null;
}
