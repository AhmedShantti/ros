import { ConflictException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SYNC_BATCH_LEASE_MS } from '../protocol/protocol.constants';

/**
 * Crash-recoverable batch reservation — Correction 2 of the D1-1 ratification,
 * and the mechanism behind the `FR-OFF-025` invariant.
 *
 * ── THE FAILURE THIS EXISTS TO REMOVE ─────────────────────────────────────
 * The shared `IdempotencyService` commits an `in_flight` row in its own
 * transaction before the handler runs, and deletes it via `release()` when the
 * handler FAILS. A process death handles nothing, so it never calls `release()`
 * — and the next attempt with the same key finds a stale `in_flight` row and is
 * told "being processed concurrently. Retry shortly." forever. For an ordinary
 * POST that is survivable; for a sync batch carrying a terminal's only copy of
 * six hours of sales it is not, and the ratification names it explicitly: "The
 * system MUST NOT leave that batch permanently trapped as 409 being processed
 * with no safe recovery path."
 *
 * ── WHY SYNC OWNS ITS OWN RECORD RATHER THAN CHANGING THE SHARED ONE ──────
 * Adding leases to `IdempotencyService` would change reservation semantics for
 * every `@Idempotent()` route in the application — orders, payments, cash
 * sessions — to suit one new endpoint. The ratification's §11 prefers "a
 * Sync-specific extension/adaptor if changing global behavior would increase
 * risk". `sync.idempotency_keys` and `IdempotencyService` are therefore
 * UNCHANGED by D4-1A; `sync.sync_batches` carries the reservation, the lease and
 * the durable response.
 *
 * ── THE LEASE ─────────────────────────────────────────────────────────────
 * A live lease means a peer really is working. An expired lease means its owner
 * died. Reclaim is an optimistic UPDATE predicated on the OBSERVED
 * `(lease_owner, attempt)` pair, so two servers racing to reclaim the same
 * abandoned batch cannot both succeed — the loser sees 0 rows updated and backs
 * off with a 409 rather than processing in parallel with the winner.
 *
 * Resume is safe because operation-level dedup is global and authoritative: the
 * reclaimer does not need to reconstruct what the dead owner had applied. It
 * simply re-runs the batch, and the dedup registry answers `duplicate` for
 * everything already settled. That is why Correction 1 and Correction 2 are
 * complementary rather than independent.
 */

export type BatchReservation =
  /** This process owns the batch and must process it. `resumed` when reclaimed. */
  | {
      readonly kind: 'acquired';
      readonly leaseOwner: string;
      readonly attempt: number;
      readonly resumed: boolean;
    }
  /** Already completed: replay the stored response verbatim (`FR-API-022`). */
  | { readonly kind: 'replay'; readonly response: unknown };

@Injectable()
export class BatchReservationService {
  /** Identifies THIS process for the lifetime of the process. */
  private readonly processId = newId();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim the batch, discover it is already answered, or refuse.
   *
   * @throws ConflictException 409 — a different body under the same batchId
   *         (`FR-API-023`, a client defect), or a live owner.
   */
  async reserve(input: {
    tenantId: string;
    batchId: string;
    terminalId: string;
    fingerprint: string;
    protocolVersion: number;
    operationCount: number;
    byteSize: number;
  }): Promise<BatchReservation> {
    const now = new Date();
    const leaseOwner = `${this.processId}:${now.getTime()}`;
    const leaseExpiresAt = new Date(now.getTime() + SYNC_BATCH_LEASE_MS);

    return this.prisma.withAuthContext(
      { tenantId: input.tenantId },
      async (tx) => {
        // One statement, no read-then-write race: either we insert and own it, or
        // somebody already has a row and we inspect it.
        const inserted = await tx.$executeRaw`
        INSERT INTO sync.sync_batches (
          tenant_id, batch_id, terminal_id, fingerprint, protocol_version,
          operation_count, byte_size, state, lease_owner, lease_expires_at,
          attempt, received_at
        ) VALUES (
          ${input.tenantId}::uuid, ${input.batchId}::uuid, ${input.terminalId}::uuid,
          ${input.fingerprint}, ${input.protocolVersion}, ${input.operationCount},
          ${input.byteSize}, 'in_flight', ${leaseOwner}, ${leaseExpiresAt},
          1, ${now}
        )
        ON CONFLICT (tenant_id, batch_id) DO NOTHING`;

        if (inserted === 1) {
          return {
            kind: 'acquired',
            leaseOwner,
            attempt: 1,
            resumed: false,
          } as const;
        }

        const existing = await tx.syncBatch.findUnique({
          where: {
            tenantId_batchId: {
              tenantId: input.tenantId,
              batchId: input.batchId,
            },
          },
        });
        if (!existing) {
          // The row vanished between the failed insert and this read. Refuse
          // rather than racing again; the client's retry will succeed.
          throw new ConflictException(
            'This sync batch is being processed concurrently. Retry shortly.',
          );
        }

        // FR-API-023 — same key, different request. A client defect, never a retry.
        if (existing.fingerprint !== input.fingerprint) {
          throw new ConflictException(
            'This batchId was already used for a different batch body. Reusing a ' +
              'batchId with different operations indicates a client defect.',
          );
        }
        if (existing.terminalId !== input.terminalId) {
          throw new ConflictException(
            'This batchId belongs to a different terminal.',
          );
        }

        if (existing.state === 'completed') {
          return { kind: 'replay', response: existing.response } as const;
        }

        const leaseLive =
          existing.leaseExpiresAt !== null &&
          existing.leaseExpiresAt.getTime() > now.getTime();
        if (leaseLive) {
          throw new ConflictException(
            'This sync batch is being processed concurrently. Retry shortly.',
          );
        }

        // Expired lease: the owner is presumed dead. Reclaim optimistically —
        // only one racer can match the observed (lease_owner, attempt) pair.
        const nextAttempt = existing.attempt + 1;
        const reclaimed = await tx.syncBatch.updateMany({
          where: {
            tenantId: input.tenantId,
            batchId: input.batchId,
            state: 'in_flight',
            attempt: existing.attempt,
            leaseOwner: existing.leaseOwner,
          },
          data: { leaseOwner, leaseExpiresAt, attempt: nextAttempt },
        });
        if (reclaimed.count !== 1) {
          throw new ConflictException(
            'This sync batch was reclaimed by another worker. Retry shortly.',
          );
        }
        return {
          kind: 'acquired',
          leaseOwner,
          attempt: nextAttempt,
          resumed: true,
        } as const;
      },
    );
  }

  /** Extend this attempt's lease while a long batch is still being processed. */
  async renew(
    tenantId: string,
    batchId: string,
    leaseOwner: string,
  ): Promise<void> {
    const leaseExpiresAt = new Date(Date.now() + SYNC_BATCH_LEASE_MS);
    await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.syncBatch.updateMany({
        where: { tenantId, batchId, leaseOwner, state: 'in_flight' },
        data: { leaseExpiresAt },
      }),
    );
  }

  /**
   * Persist the final response and mark the batch complete.
   *
   * MUST be awaited BEFORE the HTTP response is written. If the process dies
   * between this commit and the socket write, the client sees a transport
   * failure — non-definitive, so it retains everything and retries, and the
   * retry replays this stored response. If the order were reversed, that same
   * crash would leave the client holding a 200 for work the server has no record
   * of accepting, which is precisely `CT-01`'s "zero loss, zero duplication"
   * failure.
   */
  async complete(input: {
    tenantId: string;
    batchId: string;
    leaseOwner: string;
    response: unknown;
    durationMs: number;
    counts: Record<string, number>;
    maxClockSkewMs: bigint | null;
  }): Promise<void> {
    await this.prisma.withAuthContext({ tenantId: input.tenantId }, (tx) =>
      tx.syncBatch.updateMany({
        where: {
          tenantId: input.tenantId,
          batchId: input.batchId,
          leaseOwner: input.leaseOwner,
        },
        data: {
          state: 'completed',
          completedAt: new Date(),
          durationMs: input.durationMs,
          response: input.response as Prisma.InputJsonValue,
          acceptedCount: input.counts.accepted ?? 0,
          duplicateCount: input.counts.duplicate ?? 0,
          conflictCount: input.counts.conflict ?? 0,
          rejectedCount: input.counts.rejected ?? 0,
          deferredCount: input.counts.deferred ?? 0,
          maxClockSkewMs: input.maxClockSkewMs,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  /**
   * Give up this attempt's lease after a HANDLED failure, so the client's retry
   * can reclaim immediately instead of waiting out the lease.
   *
   * Deliberately does NOT delete the row: whatever operations already committed
   * are real, and their dedup entries must survive so the resumed attempt
   * answers `duplicate` rather than applying them a second time.
   */
  async releaseLease(
    tenantId: string,
    batchId: string,
    leaseOwner: string,
  ): Promise<void> {
    await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.syncBatch.updateMany({
        where: { tenantId, batchId, leaseOwner, state: 'in_flight' },
        data: { leaseExpiresAt: new Date(0) },
      }),
    );
  }
}
