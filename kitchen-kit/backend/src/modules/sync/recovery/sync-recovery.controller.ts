import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  isoDateTimeSchema,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  CurrentAuthorization,
  CurrentTenantContext,
  fromBody,
  IDENTITY_PERMISSIONS,
  IDENTITY_TERMINAL_TARGET_RESOLVER,
  JwtAuthGuard,
  PermissionGuard,
  RequirePermission,
  resourceTarget,
  TenantContextGuard,
} from '../../identity/contract';
import type {
  RequestAuthorization,
  TenantContext,
} from '../../identity/contract';
import { SyncBatchService } from '../batch/sync-batch.service';
import {
  SYNC_MAX_BATCH_BYTES,
  SYNC_MAX_OPERATIONS_PER_BATCH,
} from '../protocol/protocol.constants';
import { SyncBatchDto } from '../sync.dto';
import { syncBatchResultSchema } from '../sync.schemas';
import { IssueRecoveryGrantDto } from './dto/issue-recovery-grant.dto';
import { SyncRecoveryService } from './sync-recovery.service';

const recoveryGrantSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    terminalId: uuidSchema(),
    branchId: uuidSchema(),
    status: { type: 'string', enum: ['pending'] },
    issuedAt: isoDateTimeSchema(),
    expiresAt: isoDateTimeSchema(),
  },
};

/**
 * D4-1B — the LOSSLESS REVOKED-TERMINAL RECOVERY hard gate's HTTP surface.
 * See `SyncRecoveryService`'s docblock for the full design — in particular
 * WHY both routes here are authenticated as an ADMIN, never as the revoked
 * terminal itself.
 *
 *   POST /v1/sync/recovery/grants        admin-authorized, live scoped
 *                                         `identity.terminal.manage` (SAME
 *                                         permission that revokes a
 *                                         terminal — no new code invented)
 *   POST /v1/sync/recovery/:grantId/batch  the SAME admin authority,
 *                                         re-checked live against the
 *                                         grant's own recorded branch
 *                                         (`SyncRecoveryService
 *                                         .authorizeGrantForBatch`) — no
 *                                         static `@AuthorizationTarget` is
 *                                         possible here because the target
 *                                         branch is only known once the
 *                                         grant is loaded, hence this route
 *                                         is in `authorization-coverage
 *                                         .spec.ts`'s reviewed allowlist.
 */
@ApiTags('sync')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@UseGuards(JwtAuthGuard, TenantContextGuard)
@Controller({ path: 'sync/recovery', version: '1' })
export class SyncRecoveryController {
  constructor(
    private readonly recovery: SyncRecoveryService,
    private readonly batches: SyncBatchService,
  ) {}

  @Post('grants')
  @UseGuards(PermissionGuard)
  @AuthorizationTarget(
    resourceTarget(
      IDENTITY_TERMINAL_TARGET_RESOLVER,
      { terminalId: fromBody('terminalId') },
      'identity.terminals.branch_id is NOT NULL; a terminal always belongs to one branch.',
      'Terminal not found.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.TERMINAL_MANAGE)
  @ApiOperation({
    summary:
      'Authorize a bounded, one-shot recovery upload window for a disabled ' +
      "or revoked terminal's committed offline backlog (D1-1 GD-D1-07).",
  })
  @ApiCreatedResponse({
    description: 'The recovery grant.',
    schema: recoveryGrantSchema,
  })
  @ApiNotFoundResponse({ description: 'Terminal not found.' })
  @ApiBadRequestResponse({ description: 'Invalid ttlMinutes.' })
  @ApiForbiddenResponse({
    description: 'No tenant context / insufficient permission.',
  })
  @ApiConflictResponse({
    description:
      'Terminal is active, or a pending grant already exists for it.',
  })
  issueGrant(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: IssueRecoveryGrantDto,
  ) {
    return this.recovery.issueGrant({
      tenantId: ctx.tenantId,
      terminalId: dto.terminalId,
      authorizedByMembershipId: ctx.membershipId,
      reason: dto.reason,
      ttlMinutes: dto.ttlMinutes,
    });
  }

  @Post(':grantId/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Upload one batch of a revoked terminal's committed offline backlog, " +
      'authenticated as the admin who holds (or was granted) recovery ' +
      'authority for it — never as the terminal itself (see the service ' +
      'docblock for why).',
  })
  @ApiOkResponse({
    description: 'Per-operation results — identical shape to ordinary sync.',
    schema: syncBatchResultSchema,
  })
  @ApiBadRequestResponse({
    description: 'Malformed envelope, oversized batch, or deviceId mismatch.',
  })
  @ApiNotFoundResponse({ description: 'Recovery grant not found.' })
  @ApiForbiddenResponse({
    description: 'Caller lacks identity.terminal.manage at the grant’s branch.',
  })
  @ApiConflictResponse({
    description:
      'Grant expired, revoked, or already consumed for a different batch.',
  })
  async uploadRecoveryBatch(
    @CurrentAuthorization() auth: RequestAuthorization,
    @CurrentTenantContext() ctx: TenantContext,
    @Param('grantId') grantId: string,
    @Body() batch: SyncBatchDto,
  ) {
    if (batch.operations.length > SYNC_MAX_OPERATIONS_PER_BATCH) {
      throw new BadRequestException(
        `A batch carries at most ${SYNC_MAX_OPERATIONS_PER_BATCH} operations.`,
      );
    }
    const byteSize = Buffer.byteLength(JSON.stringify(batch), 'utf8');
    if (byteSize > SYNC_MAX_BATCH_BYTES) {
      throw new BadRequestException(
        `This batch is ${byteSize} bytes; the limit is ${SYNC_MAX_BATCH_BYTES}.`,
      );
    }

    const authorized = await this.recovery.authorizeGrantForBatch(
      auth,
      ctx.tenantId,
      grantId,
      batch.batchId,
    );

    if (batch.deviceId !== authorized.terminalId) {
      throw new BadRequestException(
        'deviceId does not match the terminal named by this recovery grant.',
      );
    }

    const result = await this.batches.process({
      tenantId: ctx.tenantId,
      terminalId: authorized.terminalId,
      branchId: authorized.branchId,
      batch,
    });

    await this.recovery.recordBatchProcessed(ctx.tenantId, grantId, result);

    return result;
  }
}
