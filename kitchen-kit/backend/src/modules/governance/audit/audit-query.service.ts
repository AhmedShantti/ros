import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEntry, Prisma } from '../../../generated/prisma/client';
import { AuditService } from './audit.service';
import { AUDIT_ACTION, AUDIT_ENTITY } from './audit.constants';
import {
  AUDIT_EXPORT_MAX_RECORDS,
  AUDIT_QUERY_DEFAULT_LIMIT,
  AuditEntryExportQueryDto,
  AuditEntryQueryDto,
} from './audit-query.dto';

/** The wire shape of one audit entry — every `FR-AUD-002` field, unabridged. */
export interface AuditEntryView {
  readonly id: string;
  readonly tenantId: string;
  readonly branchId: string | null;
  readonly sequenceNo: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actorId: string | null;
  readonly actorType: string;
  readonly impersonatedBy: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  readonly reasonCode: string | null;
  readonly reasonText: string | null;
  readonly approverId: string | null;
  readonly approvalId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly terminalId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  /** Hex-encoded `entry_hash` — the persisted tamper-evidence field, verbatim. */
  readonly entryHash: string;
  /** Hex-encoded `previous_hash`, or null for a chain's first entry. */
  readonly previousHash: string | null;
}

export interface AuditEntrySearchResult {
  readonly entries: readonly AuditEntryView[];
  /** Present when more rows exist beyond this page; pass back as `cursor`. */
  readonly nextCursor: string | null;
}

export interface AuditEntryExportResult {
  readonly entries: readonly AuditEntryView[];
  readonly count: number;
}

interface CallerContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId: string;
}

function toView(row: AuditEntry): AuditEntryView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    sequenceNo: row.sequenceNo.toString(),
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    actorId: row.actorId,
    actorType: row.actorType,
    impersonatedBy: row.impersonatedBy,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeState: row.beforeState,
    afterState: row.afterState,
    reasonCode: row.reasonCode,
    reasonText: row.reasonText,
    approverId: row.approverId,
    approvalId: row.approvalId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    terminalId: row.terminalId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    entryHash: Buffer.from(row.entryHash).toString('hex'),
    previousHash: row.previousHash
      ? Buffer.from(row.previousHash).toString('hex')
      : null,
  };
}

/** Shared WHERE builder for the six FR-AUD-008 filters. Never trusts a raw string as SQL. */
function buildWhere(
  tenantId: string,
  filters: {
    branchId?: string;
    actorId?: string;
    entityType?: string;
    entityId?: string;
    action?: string;
    correlationId?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Prisma.AuditEntryWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (filters.dateFrom) occurredAt.gte = new Date(filters.dateFrom);
  if (filters.dateTo) occurredAt.lte = new Date(filters.dateTo);

  return {
    tenantId,
    ...(filters.branchId ? { branchId: filters.branchId } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.dateFrom || filters.dateTo ? { occurredAt } : {}),
  };
}

/**
 * FR-AUD-007/008 — the auditor query/export surface over `governance.
 * audit_entries`.
 *
 * ── READ-ONLY OVER THE EXISTING CHAIN, NOTHING RE-DERIVED ────────────────
 * Every field on {@link AuditEntryView} is read straight off the persisted
 * row. `entryHash`/`previousHash` are returned as the OPAQUE bytes already on
 * the row (hex-encoded for the wire) — this service never calls
 * `computeEntryHash` and cannot alter what is hashed or how (D-19 unchanged).
 *
 * ── PAGINATION IS KEYSET, NOT OFFSET ──────────────────────────────────────
 * `sequence_no` is a per-tenant, gap-free, immutable, strictly monotonic
 * integer (`FR-AUD-004`, enforced by the advisory-lock-serialized writer and
 * the `uq_audit_sequence` unique constraint). Ordering DESC and filtering
 * `sequenceNo < cursor` is therefore a stable, deterministic, correct keyset
 * cursor with NO snapshot needed: a page already returned can never change
 * (the chain is append-only) and a concurrent append can only ever add rows
 * ABOVE the cursor, which a page already served never revisits. This is
 * stronger than the OFFSET pagination this repository avoids elsewhere (see
 * `scheduled-job-occurrence.store.ts`'s own reasoning against re-evaluated
 * subqueries) — there is no "page drift" failure mode to avoid here at all.
 *
 * ── FR-AUD-007: AUDIT LOG ACCESS IS ITSELF AUDITED ────────────────────────
 * Every call to {@link search} or {@link exportEntries} records exactly one
 * `AUDIT_LOG_QUERIED` / `AUDIT_LOG_EXPORTED` entry, through the EXISTING
 * `AuditService.record`, in the SAME transaction as the read — the existing
 * hash-chain writer, the existing advisory lock, no new audit mechanism. The
 * entry's `afterState` carries the filters applied and the result count, never
 * the audit-record CONTENT read (that would double every export's size for no
 * evidentiary value the read itself does not already provide).
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * Every read runs inside `PrismaService.withAuthContext({ tenantId })`, so
 * `audit_entries`' FORCE-RLS policy (ADR 0007, unchanged) is the actual
 * boundary — no cross-tenant row is ever visible to this service, regardless
 * of what a caller supplies. `branchId` is an additional, optional narrowing
 * filter; `AuditQueryController`'s `branchFromQueryOrTenant` target makes
 * omitting it a TENANT-scope request (requires a tenant-scope grant) and
 * supplying it a BRANCH-scope request (satisfied by a branch-scope grant
 * covering that branch) — the same mechanism every other tenant-wide
 * collection read in this repository uses (ADR 0009 D-03).
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async search(
    caller: CallerContext,
    query: AuditEntryQueryDto,
  ): Promise<AuditEntrySearchResult> {
    const limit = query.limit ?? AUDIT_QUERY_DEFAULT_LIMIT;
    const where = buildWhere(caller.tenantId, query);
    if (query.cursor) {
      where.sequenceNo = { lt: BigInt(query.cursor) };
    }

    const rows = await this.prisma.withAuthContext(
      { tenantId: caller.tenantId, userId: caller.userId },
      async (tx) => {
        const rows = await tx.auditEntry.findMany({
          where,
          orderBy: { sequenceNo: 'desc' },
          take: limit + 1,
        });
        await this.recordAccess(
          tx,
          caller,
          AUDIT_ACTION.AUDIT_LOG_QUERIED,
          query,
          Math.min(rows.length, limit),
        );
        return rows;
      },
    );

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      entries: page.map(toView),
      nextCursor: hasMore ? page[page.length - 1].sequenceNo.toString() : null,
    };
  }

  async exportEntries(
    caller: CallerContext,
    query: AuditEntryExportQueryDto,
  ): Promise<AuditEntryExportResult> {
    const where = buildWhere(caller.tenantId, query);

    const rows = await this.prisma.withAuthContext(
      { tenantId: caller.tenantId, userId: caller.userId },
      async (tx) => {
        const rows = await tx.auditEntry.findMany({
          where,
          orderBy: { sequenceNo: 'desc' },
          take: AUDIT_EXPORT_MAX_RECORDS + 1,
        });
        if (rows.length > AUDIT_EXPORT_MAX_RECORDS) {
          // Refused BEFORE the access is recorded: a request this repository
          // never serves is not "audit log access" in FR-AUD-007's sense.
          throw new BadRequestException(
            `This export would return more than ${AUDIT_EXPORT_MAX_RECORDS} ` +
              'records. Narrow dateFrom/dateTo (or another filter) and retry.',
          );
        }
        await this.recordAccess(
          tx,
          caller,
          AUDIT_ACTION.AUDIT_LOG_EXPORTED,
          query,
          rows.length,
        );
        return rows;
      },
    );

    return { entries: rows.map(toView), count: rows.length };
  }

  private async recordAccess(
    tx: Prisma.TransactionClient,
    caller: CallerContext,
    action: (typeof AUDIT_ACTION)['AUDIT_LOG_QUERIED' | 'AUDIT_LOG_EXPORTED'],
    filters: object,
    resultCount: number,
  ): Promise<void> {
    await this.audit.record(tx, {
      tenantId: caller.tenantId,
      action,
      entityType: AUDIT_ENTITY.AUDIT_LOG,
      actorType: 'user',
      actorId: caller.userId,
      correlationId: caller.correlationId,
      metadata: { filters, resultCount },
    });
  }
}
