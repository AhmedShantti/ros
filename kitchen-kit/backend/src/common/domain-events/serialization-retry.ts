import { Prisma } from '../../generated/prisma/client';

/**
 * KDS acceptance correction §1.5/§1.6, extended by the 2026-08-31 acceptance
 * correction (Blocker B/H) — the bounded whole-UnitOfWork retry mechanism
 * for the KDS bump/bump-all/recall Unit of Work. This module is
 * deliberately generic (not Kitchen-specific): it classifies a PostgreSQL
 * serialization/deadlock failure from a normal business-rule refusal, which
 * is a property of the transaction machinery, not of any one caller.
 *
 * Detection predicate — THREE shapes, all verified against real PostgreSQL
 * failures on this repository's Prisma 7 + `@prisma/adapter-pg` stack:
 *
 *   1. a query-builder call (`tx.ticket.update(...)`) surfaces a
 *      serialization failure as `PrismaClientKnownRequestError` with code
 *      `P2034`;
 *   2. a raw call (`tx.$queryRaw`/`$executeRaw`) surfaces the same failure
 *      as `PrismaClientUnknownRequestError`, whose message embeds the
 *      original PostgreSQL SQLSTATE — `40001` (serialization_failure) or
 *      `40P01` (deadlock_detected) — because that error class carries no
 *      structured `.code`/`.meta` (unlike `PrismaClientKnownRequestError`);
 *   3. a conflict detected at COMMIT time (rather than during an
 *      intermediate statement) surfaces as a raw, UNWRAPPED
 *      `DriverAdapterError` from `@prisma/driver-adapter-utils`
 *      (`name === 'DriverAdapterError'`), never reaching either
 *      `PrismaClient*RequestError` class at all — `@prisma/adapter-pg`'s
 *      `convertDriverError` always attaches the original driver error as
 *      `err.cause.originalCode`/`err.cause.originalMessage` before mapping
 *      it to a `kind` (`'TransactionWriteConflict'` for `40001`; `40P01`
 *      falls through to the generic `'postgres'` kind but keeps the same
 *      `originalCode`), so checking `cause.originalCode` directly is more
 *      robust than matching on `kind`.
 *
 *   Shape 3 was discovered, not assumed: the acceptance correction's own
 *   deterministic proof that `AuditService`'s per-tenant advisory lock is
 *   NOT load-bearing (removing it entirely and re-running the two-station
 *   race) exposed it — with the lock, contention was consistently caught
 *   mid-transaction (shape 1/2); with the lock removed, both sides raced
 *   all the way to COMMIT and Postgres detected the conflict there instead,
 *   which is shape 3. `@prisma/driver-adapter-utils` is not a direct
 *   dependency of this project (a transitive one, pulled in by
 *   `@prisma/adapter-pg`), so its `isDriverAdapterError` helper and
 *   `DriverAdapterError` class are not imported here — the check below is a
 *   narrow, defensively-typed duck-type of the exact shape observed.
 *
 * Nothing else is ever treated as retryable: a business-rule refusal (403,
 * 404, 409 idempotency mismatch, 422) is a plain `HttpException` or a
 * `PrismaClientKnownRequestError` with a DIFFERENT code (P2002, P2003, …),
 * none of which matches any of these three shapes.
 */
const RETRYABLE_SQLSTATE_RE = /\b(40001|40P01)\b/;
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

function isDriverAdapterSerializationFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if ((err as { name?: unknown }).name !== 'DriverAdapterError') {
    return false;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  const originalCode = (cause as { originalCode?: unknown }).originalCode;
  return (
    typeof originalCode === 'string' && RETRYABLE_SQLSTATES.has(originalCode)
  );
}

export function isSerializationFailure(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2034'
  ) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return RETRYABLE_SQLSTATE_RE.test(err.message);
  }
  return isDriverAdapterSerializationFailure(err);
}

/**
 * Thrown when the bounded retry budget is exhausted while every attempt kept
 * failing with a genuine serialization/deadlock error. The caller maps this
 * onto the repository's existing "lost a race, reload and retry" 409
 * convention (`OrderVersionConflictError`'s own precedent) — never 422, which
 * would wrongly say the operation can never succeed.
 */
export class SerializationRetryExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationRetryExhaustedError';
  }
}
