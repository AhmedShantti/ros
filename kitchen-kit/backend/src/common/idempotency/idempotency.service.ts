import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../modules/governance/audit/audit-hash';
import { PrismaService } from '../../prisma/prisma.service';

/** FR-API-021: "at least 30 days". */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ReservationOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly response: StoredResponse };

/**
 * Reusable idempotency store — SRS §26.5 (FR-API-020…023).
 *
 * Deliberately transport-agnostic: it deals in a key, an endpoint, a
 * fingerprint and a stored `{status, body}`. The HTTP interceptor supplies
 * those, so the same component can later serve the Sync batch path or any other
 * financially significant command without change.
 *
 * ── FINGERPRINT ─────────────────────────────────────────────────────────────
 * SHA-256 over `stableStringify({method, path, body})` — the same recursive
 * key-sorting canonicaliser the audit hash chain uses (`stableStringify`). Deterministic, so an
 * identical retry always produces an identical digest regardless of JSON key
 * order. Nothing volatile (timestamps, request ids, headers) enters the digest,
 * so a genuine retry is never mistaken for a different request; and no header,
 * token or secret material is stored.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 * `reserve()` commits an `in_flight` row in its OWN transaction before the
 * handler runs. The `(tenant_id, key)` primary key makes that atomic: a second
 * concurrent request cannot also reserve, so the work happens once. The loser
 * gets 409 rather than a duplicate Order.
 *
 * A handler failure calls `release()`, deleting the reservation so a later retry
 * can proceed — a failed attempt must never leave a record that would later
 * replay as if it had succeeded.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Deterministic request digest. */
  fingerprint(method: string, path: string, body: unknown): string {
    const canonical = stableStringify({
      method: method.toUpperCase(),
      path,
      body: body ?? null,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Claim the key, or discover that this request has already been answered.
   *
   * @throws ConflictException on a fingerprint mismatch (FR-API-023) or when the
   *         same key is currently in flight.
   */
  async reserve(
    tenantId: string,
    key: string,
    endpoint: string,
    fingerprint: string,
  ): Promise<ReservationOutcome> {
    // Both stamps come from ONE clock reading, so the stored window is exactly
    // the retention period. Letting `first_seen_at` default to the database
    // clock would make the gap marginally SHORTER than 30 days, which
    // FR-API-021 ("at least 30 days") does not permit.
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      await this.prisma.withAuthContext({ tenantId }, (tx) =>
        tx.idempotencyKey.create({
          data: {
            tenantId,
            key,
            endpoint,
            fingerprint,
            firstSeenAt: now,
            expiresAt,
          },
        }),
      );
      return { kind: 'proceed' };
    } catch {
      // The key already exists for this tenant — either a genuine retry, a
      // client defect, or a concurrent duplicate. Which one is decided below.
    }

    const existing = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } },
      }),
    );
    if (!existing) {
      // The row vanished between the failed insert and this read (a concurrent
      // release). Treat as a conflict rather than silently racing again.
      throw new ConflictException(
        'This Idempotency-Key is being processed concurrently. Retry shortly.',
      );
    }

    // FR-API-023 — a different request under the same key is a client defect.
    if (
      existing.fingerprint !== fingerprint ||
      existing.endpoint !== endpoint
    ) {
      throw new ConflictException(
        'This Idempotency-Key was already used for a different request. ' +
          'Reusing a key with a different payload indicates a client defect.',
      );
    }

    if (existing.state !== 'completed' || existing.responseStatus === null) {
      throw new ConflictException(
        'This Idempotency-Key is being processed concurrently. Retry shortly.',
      );
    }

    // FR-API-022 — identical fingerprint, return the stored response.
    return {
      kind: 'replay',
      response: {
        status: existing.responseStatus,
        body: existing.responseBody,
      },
    };
  }

  /** Persist the response so a later retry replays it verbatim (FR-API-022). */
  async complete(
    tenantId: string,
    key: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.idempotencyKey.update({
        where: { tenantId_key: { tenantId, key } },
        data: {
          state: 'completed',
          responseStatus: response.status,
          responseBody: response.body as never,
          completedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Drop a reservation whose handler failed, so the client may retry.
   *
   * Without this a transient failure would poison the key: the next attempt
   * would find an `in_flight` row and be refused forever.
   */
  async release(tenantId: string, key: string): Promise<void> {
    await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.idempotencyKey.deleteMany({
        where: { tenantId, key, state: 'in_flight' },
      }),
    );
  }
}
