import { Injectable } from '@nestjs/common';

/**
 * Deterministic crash-simulation seam for the sync kernel.
 *
 * `test/sync-crash-recovery.e2e-spec.ts` has to prove that a process dying
 * PART-WAY through a batch — after some operations have committed but before
 * the batch response is persisted — leaves the system recoverable. Killing the
 * Jest worker would prove it only by accident and could not assert anything
 * afterwards, so the brief calls for "deterministic hooks/failpoints in tests"
 * rather than random termination.
 *
 * ── IN PRODUCTION THIS IS INERT ───────────────────────────────────────────
 * `afterChunk` is `null` and stays `null`: nothing in `src/` ever assigns it,
 * there is no environment variable or config key that turns it on, and the call
 * site is a single null check. A test reaches in with
 * `app.get(SyncFailpoint).afterChunk = ...`.
 *
 * A plain injectable holder is used deliberately in preference to a DI token
 * that tests override: `SyncBatchService` is declared inside `SyncModule`, so a
 * provider registered by a test's root module is not visible to it, and a
 * symbol-token override proved not to apply. A holder whose FIELD is mutated
 * needs none of that machinery and cannot silently fail to take effect.
 */
@Injectable()
export class SyncFailpoint {
  /** Called after a chunk has COMMITTED. Throwing simulates a process death. */
  afterChunk: ((chunkIndex: number) => Promise<void>) | null = null;
}
