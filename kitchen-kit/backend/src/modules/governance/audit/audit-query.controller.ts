import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { newId } from '../../../common/ids';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  branchFromQueryOrTenant,
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequirePermission,
  TenantContextGuard,
} from '../../identity/contract';
import type { TenantContext } from '../../identity/contract';
import {
  AuditEntryExportQueryDto,
  AuditEntryQueryDto,
} from './audit-query.dto';
import { AuditQueryService } from './audit-query.service';
import { AUDIT_PERMISSIONS } from './audit.permissions';

// Shape verified against `AuditEntryView` (`audit-query.service.ts`) — every
// FR-AUD-002 field, unabridged.
const auditEntrySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    branchId: nullable(uuidSchema()),
    sequenceNo: {
      type: 'string',
      description: 'Per-tenant hash-chain position (BigInt on the wire).',
    },
    occurredAt: isoDateTimeSchema(),
    recordedAt: isoDateTimeSchema(),
    actorId: nullable(uuidSchema()),
    actorType: {
      type: 'string',
      enum: ['user', 'anonymous', 'system', 'terminal'],
    },
    impersonatedBy: nullable(uuidSchema()),
    action: { type: 'string' },
    entityType: { type: 'string' },
    entityId: nullable(uuidSchema()),
    beforeState: nullable({}),
    afterState: nullable({}),
    reasonCode: nullable({ type: 'string' }),
    reasonText: nullable({ type: 'string' }),
    approverId: nullable(uuidSchema()),
    approvalId: nullable(uuidSchema()),
    ipAddress: nullable({ type: 'string' }),
    userAgent: nullable({ type: 'string' }),
    terminalId: nullable(uuidSchema()),
    correlationId: uuidSchema(),
    causationId: nullable(uuidSchema()),
    entryHash: {
      type: 'string',
      description: 'Hex-encoded SHA-256 tamper-evidence hash (FR-AUD-004).',
    },
    previousHash: nullable({
      type: 'string',
      description: "Hex-encoded; null for a chain's first entry.",
    }),
  },
};

/**
 * FR-AUD-007/008 — the auditor query/export surface (AUD-R1).
 *
 *   GET /governance/audit/entries         — search/filter, keyset-paginated.
 *   GET /governance/audit/entries/export  — bounded export (dateFrom/dateTo
 *                                            required); requires audit.view
 *                                            AND report.export together.
 *
 * Guard chain: `JwtAuthGuard` (401) → `TenantContextGuard` (403, no active
 * tenant context) → `PermissionGuard` (403, scope AND permission —
 * `branchFromQueryOrTenant('branchId')`: a TENANT-target request when
 * `branchId` is omitted, a BRANCH-target request against exactly that branch
 * when it is supplied — never silently narrowed).
 *
 * Both routes are dashboard-only reads over the EXISTING `governance.
 * audit_entries` chain — no new audit-writing mechanism, no re-signing, no
 * mutation of any kind. See `AuditQueryService`'s own docblock for the
 * pagination-safety and FR-AUD-007 self-audit reasoning, and `AUD-R1` in
 * `docs/governance/GOVERNANCE_DECISION_REGISTER.md` for the permission-code
 * ratification (including its narrow, explicit amendment of RPT-R1 clause 6).
 */
@ApiTags('governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('governance/audit/entries')
export class AuditQueryController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  @RequirePermission(AUDIT_PERMISSIONS.VIEW)
  @AuthorizationTarget(branchFromQueryOrTenant('branchId'))
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Search/filter the tenant audit log (FR-AUD-008). Requires audit.view.',
    description:
      'Filters: actorId, entityType, entityId, action, dateFrom/dateTo, ' +
      'branchId, correlationId — the exact FR-AUD-008 filter set. Ordered by ' +
      'sequenceNo DESC (most recent first); keyset-paginated via `cursor` ' +
      '(the last sequenceNo already seen) — never OFFSET, so no page can ' +
      'skip or duplicate a row. `limit` defaults to 50, max 200. Every call ' +
      'records its own AUDIT_LOG_QUERIED audit entry (FR-AUD-007).',
  })
  @ApiOkResponse({
    description: 'A page of audit entries, most recent first.',
    schema: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: auditEntrySchema },
        nextCursor: nullable({ type: 'string' }),
      },
    },
  })
  @ApiBadRequestResponse({ description: 'A filter value is malformed.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description:
      'No active tenant context, audit.view is not held, or (when branchId ' +
      'is supplied) no held grant covers that branch.',
  })
  async search(
    @Query() query: AuditEntryQueryDto,
    @CurrentTenantContext() context: TenantContext,
  ) {
    return this.auditQuery.search(
      {
        tenantId: context.tenantId,
        userId: context.userId,
        correlationId: newId(),
      },
      query,
    );
  }

  @Get('export')
  @RequirePermission(AUDIT_PERMISSIONS.VIEW, AUDIT_PERMISSIONS.EXPORT)
  @AuthorizationTarget(branchFromQueryOrTenant('branchId'))
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary:
      'Export the tenant audit log (FR-AUD-008). Requires audit.view AND report.export.',
    description:
      'Same six filters as search; dateFrom/dateTo are REQUIRED so every ' +
      'export is bounded. Refused (400) if more than 10,000 records would ' +
      'match — narrow the date range and retry. Not paginated: a bounded, ' +
      'complete result for the requested range in one response, preserving ' +
      'every canonical audit fact and hash-chain field (entryHash, ' +
      'previousHash) verbatim — nothing is re-derived, re-signed, or ' +
      'modified. Every call records its own AUDIT_LOG_EXPORTED audit entry ' +
      '(FR-AUD-007).',
  })
  @ApiOkResponse({
    description: 'The complete, bounded set of matching audit entries.',
    schema: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: auditEntrySchema },
        count: { type: 'integer' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'A filter value is malformed, dateFrom/dateTo is missing, or the ' +
      'match count exceeds the 10,000-record export bound.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description:
      'No active tenant context, audit.view and report.export are not BOTH ' +
      'held, or (when branchId is supplied) no held grant covers that branch.',
  })
  async exportEntries(
    @Query() query: AuditEntryExportQueryDto,
    @CurrentTenantContext() context: TenantContext,
  ) {
    return this.auditQuery.exportEntries(
      {
        tenantId: context.tenantId,
        userId: context.userId,
        correlationId: newId(),
      },
      query,
    );
  }
}
