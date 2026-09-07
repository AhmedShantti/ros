import {
  Body,
  Controller,
  Get,
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
  ApiOkResponse,
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
import {
  toCashClosePolicyView,
  toResolvedCashClosePolicyView,
} from '../treasury.views';
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
 * table).
 *
 * GET (GOLDEN-PATH-BACKEND-CLOSURE, 2026-09-07): the original design gate
 * left the write route reachable with no paired read, citing FR-PLT-027's
 * settings inspector as out of scope — but that argument does not cover a
 * plain "what applies to this branch right now" read, which FR-PLT-027 never
 * owned (the inspector's job is showing every override LEVEL and which one
 * won; this returns the one resolved value, exactly what the write route
 * already echoes back on create). Its absence left this route
 * administratively unreachable in practice: the golden-path audit found no
 * console/dashboard surface could tell an Owner whether a branch already had
 * a policy before deciding whether to create one. Same guards, same
 * permission, still no `@AllowPosSession` — a read of branch administrative
 * configuration is exactly as POS-inappropriate as writing it.
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

  /**
   * The currently-effective cash-close policy for a branch, wrapped as
   * `{ policy: ... | null }` — GOLDEN-PATH-BACKEND-CLOSURE (2026-09-07).
   * `policy` is `null` when none has ever been configured; a bare top-level
   * `null` body is deliberately avoided (Express sends an empty body for a
   * handler returning `null`, which is indistinguishable on the wire from
   * "no response content" — a wrapper object keeps `null` an unambiguous,
   * inspectable JSON value). Not FR-PLT-027's settings inspector (see class
   * docblock) — a single resolved value, not a level-by-level override
   * trace.
   */
  @Get(':branchId/cash-close-policy')
  @AuthorizationTarget(branchFromParam('branchId'))
  @HttpCode(HttpStatus.OK)
  @RequirePermission(TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE)
  @ApiOkResponse({
    description:
      '`policy` is null if the branch has none configured yet.',
    schema: {
      type: 'object',
      properties: {
        policy: {
          nullable: true,
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
                "ISO 4217 currency code — the branch's own base currency.",
              example: 'AED',
            },
            varianceApprovalExpirySeconds: { type: 'integer', minimum: 1 },
            createdAt: isoDateTimeSchema(),
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Unknown branch.' })
  async getPolicy(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    const policy = await this.policies.getCurrent(
      context.tenantId,
      context.userId,
      branchId,
    );
    return { policy: policy ? toResolvedCashClosePolicyView(policy) : null };
  }
}
