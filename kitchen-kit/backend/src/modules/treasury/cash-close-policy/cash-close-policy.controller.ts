import {
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';
import { toCashClosePolicyView } from '../treasury.views';
import { CashClosePolicyService } from './cash-close-policy.service';
import { CreateCashClosePolicyDto } from './cash-close-policy.dto';
import { AuthorizationTarget, branchFromParam } from '../../identity/contract';

/**
 * Cash-close policy administration — P1G-1 migration 33.
 *
 * A DASHBOARD/back-office route (no `@AllowPosSession`, unlike
 * `TreasuryController`): configuring a branch's variance tolerance, count
 * mode and approval-expiry duration is a `settings.branch.manage` act, not a
 * cashier operation, so `JwtAuthGuard` rejects a PIN-issued session here by
 * default (FR-SEC-021 — "SHALL NOT grant access to the web dashboard", and
 * the converse holds too: a POS session gets no back-office surface it was
 * not deliberately opted into).
 *
 * ROUTE (C-1 — no isolated `/v1` retrofit; the repository's existing
 * convention has no version prefix in any controller, applied at deployment
 * only, per `swagger.config.ts`):
 *
 *   POST /branches/{branchId}/cash-close-policy
 *
 * A separate controller from `TreasuryController`, on a DIFFERENT resource
 * family (`/branches/...`, not `/cash-sessions/...`), because this resource
 * is branch-scoped configuration, not a cash-session operation — mirroring
 * how Organisation's own branch-admin routes live under `/org/branches/...`
 * while Treasury's shift/session routes live under `/cash-sessions`. Both
 * families are legitimate; nesting policy administration under
 * `/cash-sessions` would misdescribe what it configures.
 *
 * DELIBERATELY ABSENT: PATCH/PUT (no update — a new configuration is always
 * a NEW immutable version, §20), DELETE (no DELETE grant exists on the
 * table), and any read/inspector endpoint (FR-PLT-027's settings inspector
 * is `[S]` and out of scope; §26 permits an admin write route without one).
 */
@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('branches')
export class CashClosePolicyController {
  constructor(private readonly policies: CashClosePolicyService) {}

  /**
   * Create a new immutable cash-close policy version for a branch — R-1(a),
   * R-4(a), R-5. `Idempotency-Key` is MANDATORY (FR-API-020): a retry over a
   * flaky link must not produce a second version.
   */
  @Post(':branchId/cash-close-policy')
  @AuthorizationTarget(branchFromParam('branchId'))
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The newly created cash-close policy version.',
    schema: {
      type: 'object',
      properties: {
        id: uuidSchema(),
        branchId: uuidSchema(),
        effectiveFrom: isoDateTimeSchema(),
        countMode: { type: 'string', enum: ['blind', 'open'] },
        varianceToleranceMinorUnits: moneyStringSchema(
          'Non-negative minor-unit tolerance as a decimal string.',
        ),
        currency: {
          type: 'string',
          description:
            "ISO 4217 currency code — the branch's own base currency, never client-supplied.",
          example: 'AED',
        },
        varianceApprovalExpirySeconds: { type: 'integer', minimum: 1 },
        createdBy: uuidSchema(),
        createdAt: isoDateTimeSchema(),
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, an invalid varianceToleranceMinorUnits/varianceApprovalExpirySeconds/countMode, or a past effectiveFrom.',
  })
  @ApiNotFoundResponse({ description: 'Unknown branch.' })
  @ApiConflictResponse({
    description:
      'A cash-close policy version with this exact effective time already exists for this branch, or the Idempotency-Key was already used with a different request body / is still in flight.',
  })
  async createPolicy(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateCashClosePolicyDto,
  ) {
    const policy = await this.policies.create(
      context.tenantId,
      context.userId,
      {
        branchId,
        varianceToleranceMinorUnits: dto.varianceToleranceMinorUnits,
        varianceApprovalExpirySeconds: dto.varianceApprovalExpirySeconds,
        countMode: dto.countMode,
        effectiveFrom: dto.effectiveFrom,
      },
    );
    return toCashClosePolicyView(policy);
  }
}
