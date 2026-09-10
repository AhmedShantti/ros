import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
  AuthorizationTarget,
  brandFromParam,
  branchFromParam,
  branchFromQueryOrTenant,
  CurrentAuthorization,
  CurrentTenantContext,
  fromParam,
  JwtAuthGuard,
  PermissionGuard,
  RequireAnyPermission,
  RequirePermission,
  resourceTarget,
  TenantContextGuard,
  tenantTarget,
} from '../../identity/contract';
import type {
  RequestAuthorization,
  TenantContext,
} from '../../identity/contract';
import { ORGANISATION_PERMISSIONS } from '../../organisation/contract';
import { ServiceChargePolicyService } from './service-charge-policy.service';
import { SERVICE_CHARGE_POLICY_TARGET_RESOLVER } from './service-charge-policy-target.resolver';
import { CreateServiceChargePolicyDto } from './service-charge-policy.dto';
import {
  serviceChargePolicyResponseSchema,
  toResolvedServiceChargePolicyView,
  toServiceChargePolicyView,
} from './service-charge-policy.views';

/**
 * ServiceChargePolicy administration — P2D (ratified P2D-R1).
 *
 * A DASHBOARD/back-office resource (no `@AllowPosSession`, mirroring
 * `CashClosePolicyController`): configuring service-charge policy is a
 * `TENANT_MANAGE`/`BRANCH_MANAGE` act, never a cashier operation.
 *
 * WRITE — one route PER LEVEL (tenant/brand/branch), reusing the EXISTING
 * `ORGANISATION_PERMISSIONS.TENANT_MANAGE`/`BRANCH_MANAGE` permissions
 * (the exact `PlatformSettingsController` convention: tenant+brand writes
 * use `TENANT_MANAGE`, branch writes use `BRANCH_MANAGE`) — no new
 * permission is minted.
 *
 * READ — `resolve` (the currently-effective version for a hierarchy
 * context, mirrors `CashClosePolicyController.getPolicy`) and `versions`
 * (every version for one EXACT scope, including future-scheduled ones —
 * the minimum surface needed to make `cancel` usable at all, since
 * `resolve` only ever shows the current winner; see
 * `ServiceChargePolicyService.listVersions`'s own docblock).
 *
 * CANCEL — a still-FUTURE version only (P2A-R1 clause 11). Authorization
 * is based on the ROW's OWN scope, established only after reading it
 * (`ServiceChargePolicyService.cancel`'s own docblock) — this route's
 * static guard is therefore a COARSE pre-filter only
 * (`RequireAnyPermission`), not the final authorization word.
 *
 * DELIBERATELY ABSENT: PATCH/PUT (no update — a new configuration is
 * always a NEW immutable version); FR-PLT-027 generic inspector
 * integration (P2D-R1 clause 12 — a narrow domain-owned read is
 * sufficient, this table is not the generic six-level hierarchy).
 */
@ApiTags('sales')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('service-charge-policy')
export class ServiceChargePolicyController {
  constructor(private readonly policies: ServiceChargePolicyService) {}

  @Post('tenant')
  @AuthorizationTarget(
    tenantTarget('Tenant-level service-charge policy administration.'),
  )
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  @ApiCreatedResponse({
    description:
      'The newly created tenant-level service-charge policy version.',
    schema: serviceChargePolicyResponseSchema(),
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, an invalid rules array, or a past effectiveFrom.',
  })
  @ApiConflictResponse({
    description:
      'A version with this exact effective time already exists for this scope.',
  })
  async createTenantPolicy(
    @CurrentTenantContext() context: TenantContext,
    @Body() dto: CreateServiceChargePolicyDto,
  ) {
    const policy = await this.policies.create(
      context.tenantId,
      context.userId,
      {
        level: 'tenant',
        targetId: context.tenantId,
        rules: dto.rules,
        locked: dto.locked,
        effectiveFrom: dto.effectiveFrom,
      },
    );
    return toServiceChargePolicyView(policy);
  }

  @Post('brand/:brandId')
  @AuthorizationTarget(brandFromParam('brandId'))
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  @ApiCreatedResponse({
    description: 'The newly created brand-level service-charge policy version.',
    schema: serviceChargePolicyResponseSchema(),
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, an invalid rules array, or a past effectiveFrom.',
  })
  @ApiNotFoundResponse({ description: 'Unknown brand.' })
  @ApiConflictResponse({
    description:
      'A version with this exact effective time already exists for this scope.',
  })
  async createBrandPolicy(
    @CurrentTenantContext() context: TenantContext,
    @Param('brandId') brandId: string,
    @Body() dto: CreateServiceChargePolicyDto,
  ) {
    const policy = await this.policies.create(
      context.tenantId,
      context.userId,
      {
        level: 'brand',
        targetId: brandId,
        rules: dto.rules,
        locked: dto.locked,
        effectiveFrom: dto.effectiveFrom,
      },
    );
    return toServiceChargePolicyView(policy);
  }

  @Post('branch/:branchId')
  @AuthorizationTarget(branchFromParam('branchId'))
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  @ApiCreatedResponse({
    description:
      'The newly created branch-level service-charge policy version.',
    schema: serviceChargePolicyResponseSchema(),
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, an invalid rules array, or a past effectiveFrom.',
  })
  @ApiNotFoundResponse({ description: 'Unknown branch.' })
  @ApiConflictResponse({
    description:
      'A version with this exact effective time already exists for this scope.',
  })
  async createBranchPolicy(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateServiceChargePolicyDto,
  ) {
    const policy = await this.policies.create(
      context.tenantId,
      context.userId,
      {
        level: 'branch',
        targetId: branchId,
        rules: dto.rules,
        locked: dto.locked,
        effectiveFrom: dto.effectiveFrom,
      },
    );
    return toServiceChargePolicyView(policy);
  }

  /**
   * The currently-effective version for a hierarchy context — `null` if
   * nothing is configured anywhere in scope. `branchId` (when supplied)
   * determines the authorization target; otherwise TENANT — the built-in
   * `branchFromQueryOrTenant` primitive, no custom resolver needed. A
   * `brandId`-only request (no `branchId`) is authorized at TENANT scope
   * — safe (never more permissive than the dedicated multi-level resolver
   * `PlatformSettingsController` uses would be), simpler, and avoids a
   * new Sales-owned `ScopeTargetResolver` for a narrow admin read.
   */
  @Get('resolve')
  @AuthorizationTarget(branchFromQueryOrTenant('branchId'))
  @RequireAnyPermission(
    ORGANISATION_PERMISSIONS.TENANT_READ,
    ORGANISATION_PERMISSIONS.BRANCH_READ,
  )
  @ApiOkResponse({
    description: '`policy` is null if nothing is configured anywhere in scope.',
  })
  async resolve(
    @CurrentTenantContext() context: TenantContext,
    @Query('brandId') brandId?: string,
    @Query('branchId') branchId?: string,
  ) {
    const policy = await this.policies.getCurrent(
      context.tenantId,
      context.userId,
      {
        ...(brandId ? { brandId } : {}),
        ...(branchId ? { branchId } : {}),
      },
    );
    return {
      policy: policy ? toResolvedServiceChargePolicyView(policy) : null,
    };
  }

  /**
   * Every version for ONE exact scope, newest first — including
   * future-scheduled ones `resolve` cannot show. See
   * `ServiceChargePolicyService.listVersions`'s own docblock for why this
   * minimal surface exists.
   */
  @Get('versions')
  @AuthorizationTarget(
    tenantTarget(
      'Service-charge policy version listing (target validated inside the service).',
    ),
  )
  @RequireAnyPermission(
    ORGANISATION_PERMISSIONS.TENANT_READ,
    ORGANISATION_PERMISSIONS.BRANCH_READ,
  )
  @ApiOkResponse({
    description:
      'Every version for the given (level, targetId) scope, newest first.',
  })
  async listVersions(
    @CurrentTenantContext() context: TenantContext,
    @Query('level') level: 'tenant' | 'brand' | 'branch',
    @Query('targetId') targetId: string,
  ) {
    const versions = await this.policies.listVersions(
      context.tenantId,
      context.userId,
      level,
      targetId,
    );
    return { versions: versions.map(toServiceChargePolicyView) };
  }

  /**
   * Cancel a still-future version. `RequireAnyPermission` here is a
   * COARSE gate only — the actual, scope-precise authorization decision
   * happens inside `ServiceChargePolicyService.cancel`, after the row's
   * own level is known (see that method's docblock).
   */
  @Delete('versions/:versionId')
  @AuthorizationTarget(
    resourceTarget(
      SERVICE_CHARGE_POLICY_TARGET_RESOLVER,
      { versionId: fromParam('versionId') },
      "the version's own scope",
      'Service-charge policy version not found.',
    ),
  )
  @RequireAnyPermission(
    ORGANISATION_PERMISSIONS.TENANT_MANAGE,
    ORGANISATION_PERMISSIONS.BRANCH_MANAGE,
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiConflictResponse({
    description:
      'That version is already effective (or just became effective) and can no longer be cancelled.',
  })
  @ApiNotFoundResponse({ description: 'Unknown version.' })
  async cancel(
    @CurrentTenantContext() context: TenantContext,
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param('versionId') versionId: string,
  ) {
    await this.policies.cancel(
      context.tenantId,
      context.userId,
      authorization,
      versionId,
    );
  }
}
