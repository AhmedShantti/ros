import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/**
 * A small, deliberate duplication of `organisation/prisma-errors.ts` and
 * `workforce/schedule/schedule.service.ts`'s own local `isExclusionViolation`
 * — NOT a new cross-module import. `organisation->prisma-errors` is a
 * pre-existing `KNOWN_DEVIATIONS` entry other modules carry; Procurement adds
 * none (mission brief §1/§15), so this ~30-line pure helper is copied rather
 * than imported. See `employees.controller.ts`'s `toAssignmentScope` for the
 * same precedent.
 */

function isPrismaError(err: unknown, code: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}

/** Map a Prisma unique-constraint violation (P2002) to the project's 409 convention. */
export function rethrowAsConflict(err: unknown, message: string): never {
  if (isPrismaError(err, 'P2002')) {
    throw new ConflictException(message);
  }
  throw err;
}

/** Map a foreign-key violation (P2003) to 404 — a tenant-safe composite FK
 *  fails exactly when the referenced parent does not exist in this tenant. */
export function rethrowAsNotFoundOnFk(
  err: unknown,
  notFoundMessage: string,
  conflictMessage?: string,
): never {
  if (isPrismaError(err, 'P2003')) {
    throw new NotFoundException(notFoundMessage);
  }
  if (conflictMessage !== undefined && isPrismaError(err, 'P2002')) {
    throw new ConflictException(conflictMessage);
  }
  throw err;
}

/** PostgreSQL `exclusion_violation` (23P01), surfaced by Prisma as a raw
 *  driver-adapter error rather than a typed `PrismaClientKnownRequestError`
 *  code — same detection shape as `catalogue/pricing/price-list-overlap.ts`
 *  and `workforce/schedule/schedule.service.ts`'s own local copy. */
export function isExclusionViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = err.meta as
      | { driverAdapterError?: { cause?: { originalCode?: string } } }
      | undefined;
    if (meta?.driverAdapterError?.cause?.originalCode === '23P01') return true;
  }
  return (
    err instanceof Error &&
    /conflicting key value violates exclusion constraint/i.test(err.message)
  );
}
