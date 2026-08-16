import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

function isPrismaError(err: unknown, code: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
  );
}

/**
 * Map a Prisma unique-constraint violation (P2002) to the project's 409
 * convention; rethrow anything else untouched. Declared `never` so callers can
 * `catch (err) { rethrowAsConflict(err, '…'); }` without TypeScript losing the
 * control-flow guarantee.
 */
export function rethrowAsConflict(err: unknown, message: string): never {
  if (isPrismaError(err, 'P2002')) {
    throw new ConflictException(message);
  }
  throw err;
}

/**
 * Map a foreign-key violation (P2003) to 404. A composite tenant-safe FK
 * (ADR 0008 D-09) fails exactly when the caller references a parent that does
 * not exist *within their tenant*, so surfacing 404 — the same response as a
 * genuinely missing parent — keeps cross-tenant ids indistinguishable from
 * non-existent ones. P2002 is still mapped to 409 when `conflictMessage` is
 * supplied, because a single write can violate either.
 */
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
