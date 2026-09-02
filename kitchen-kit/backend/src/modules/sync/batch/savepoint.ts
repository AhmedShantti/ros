import { Prisma } from '../../../generated/prisma/client';

/**
 * Per-operation failure isolation inside a shared chunk transaction.
 *
 * Correction 3 of the D1-1 ratification: `FR-OFF-023` ("a single failing
 * operation SHALL NOT fail the batch") requires per-operation FAILURE
 * ISOLATION, not per-operation physical COMMIT. The design gate inferred the
 * latter and, at 500 operations in 3 seconds, that inference made
 * `NFR-PERF-032` a 6 ms budget per round-tripped transaction.
 *
 * A `SAVEPOINT` gives the isolation without the commit: a failing operation is
 * rolled back to its own savepoint, its siblings in the same transaction
 * survive untouched, and the transaction remains usable afterwards — which is
 * what lets the kernel record a definitive `rejected` settlement for the failed
 * operation instead of losing the fact that it was ever attempted.
 *
 * Savepoint names are generated from an internal counter and are never derived
 * from request data.
 */
export type SavepointResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export async function withSavepoint<T>(
  tx: Prisma.TransactionClient,
  name: string,
  fn: () => Promise<T>,
): Promise<SavepointResult<T>> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe savepoint name '${name}'.`);
  }
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error) {
    // ROLLBACK TO leaves the transaction usable and the savepoint defined;
    // releasing afterwards keeps the server's savepoint stack bounded across a
    // 500-operation batch.
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: false, error };
  }
}
