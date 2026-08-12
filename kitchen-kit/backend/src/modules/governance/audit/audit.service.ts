import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { AuditEntry, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditActorType } from './audit.constants';
import { computeEntryHash, sanitizeMetadata } from './audit-hash';

export interface AuditEvent {
  /** Real tenant id, or SENTINEL_TENANT_ID for global/anonymous auth events. */
  tenantId: string;
  action: string;
  entityType: string;
  actorType: AuditActorType;
  actorId?: string | null;
  entityId?: string | null;
  terminalId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  /** Explicit, allow-listed safe fields → after_state (sanitized again here). */
  metadata?: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
  correlationId?: string;
}

/**
 * Reusable, append-only, tamper-evident audit writer for governance.audit_entries.
 * Not coupled to any controller; usable by any current or future bounded context.
 * The chain is per-tenant (sequence_no + previous_hash → entry_hash) and made
 * concurrency-safe by a per-tenant transaction advisory lock.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append an audit entry within the caller's transaction (mandatory: an error
   * rolls back the caller). The caller MUST already have the RLS context set to
   * `event.tenantId` (i.e. be inside `withAuthContext({ tenantId })`).
   */
  async record(
    tx: Prisma.TransactionClient,
    event: AuditEvent,
  ): Promise<AuditEntry> {
    // Serialize per-tenant chain writers so sequence_no / previous_hash cannot
    // race. Transaction-scoped lock: released at COMMIT/ROLLBACK. Uses
    // $executeRawUnsafe because pg_advisory_xact_lock returns void.
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'ros_audit',
      event.tenantId,
    );

    const last = await tx.auditEntry.findFirst({
      where: { tenantId: event.tenantId },
      orderBy: { sequenceNo: 'desc' },
      select: { sequenceNo: true, entryHash: true },
    });
    const sequenceNo = (last?.sequenceNo ?? 0n) + 1n;
    const previousHash = last?.entryHash ?? null;
    const occurredAt = new Date();
    const correlationId = event.correlationId ?? newId();

    const beforeState =
      event.before != null ? sanitizeMetadata(event.before) : null;
    const afterState =
      event.metadata != null ? sanitizeMetadata(event.metadata) : null;

    const entryHash = computeEntryHash(
      {
        tenantId: event.tenantId,
        sequenceNo,
        occurredAt,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        terminalId: event.terminalId ?? null,
        reasonCode: event.reasonCode ?? null,
        beforeState,
        afterState,
        correlationId,
      },
      previousHash,
    );

    return tx.auditEntry.create({
      data: {
        id: newId(),
        tenantId: event.tenantId,
        sequenceNo,
        occurredAt,
        actorId: event.actorId ?? null,
        actorType: event.actorType,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        beforeState: (beforeState ?? undefined) as Prisma.InputJsonValue,
        afterState: (afterState ?? undefined) as Prisma.InputJsonValue,
        reasonCode: event.reasonCode ?? null,
        reasonText: event.reasonText ?? null,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
        terminalId: event.terminalId ?? null,
        correlationId,
        entryHash,
        previousHash,
      },
    });
  }

  /**
   * Append an audit entry in its own transaction (the standalone path for events
   * whose operation is not a single tenant-scoped transaction — see ADR 0007).
   * Best-effort: a failure is logged (not swallowed silently) but never turns a
   * successful operation into a failure. In-transaction, mandatory auditing uses
   * {@link record} instead.
   */
  async emit(event: AuditEvent): Promise<void> {
    try {
      await this.prisma.withAuthContext(
        { userId: event.actorId ?? undefined, tenantId: event.tenantId },
        (tx) => this.record(tx, event),
      );
    } catch (err) {
      this.logger.error(
        `Audit write failed for action=${event.action}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}
