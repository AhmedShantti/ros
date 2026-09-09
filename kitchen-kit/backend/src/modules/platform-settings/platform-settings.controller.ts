import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import {
  AuthorizationTarget,
  brandFromParam,
  branchFromParam,
  fromParam,
  fromQuery,
  resourceOrTenantTarget,
  resourceTarget,
  tenantTarget,
  IDENTITY_TERMINAL_TARGET_RESOLVER,
  JwtAuthGuard,
  PermissionGuard,
  RequireAnyPermission,
  RequirePermission,
  CurrentTenantContext,
  TenantContextGuard,
} from '../identity/contract';
import type { TenantContext } from '../identity/contract';
import { ORGANISATION_PERMISSIONS } from '../organisation/contract';
import { PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER } from './platform-settings-scope-target.resolver';
import { SettingsAdminService } from './settings-admin.service';
import { SettingsInspectorService } from './settings-inspector.service';
import { SettingsResolverService } from './settings-resolver.service';
import { ResolveSettingsQueryDto } from './dto/resolve-settings-query.dto';
import { UpsertSettingValueDto } from './dto/upsert-setting-value.dto';
import {
  toEffectiveSettingView,
  toInspectorView,
  toSettingValueView,
} from './platform-settings.views';

/**
 * FR-PLT-025/026/027 — the settings resolver's HTTP surface.
 *
 * READ (`resolve`/`inspect`): a caller narrows the request with an optional
 * `brandId`/`branchId`/`terminalId`; the deepest one supplied determines the
 * authorization target (`PlatformSettingsScopeTargetResolver`) and is
 * validated for hierarchy consistency the SAME way a write is
 * (`SettingsScopeService`).
 *
 * WRITE: one route PER LEVEL (tenant/brand/branch/terminal — Platform
 * Default and Country Pack are not writable here, see
 * `SettingsAdminService`'s own docblock), reusing the EXISTING
 * `settings.tenant.manage`/`settings.branch.manage` permissions (ADR 0008
 * D-01) rather than inventing new ones — Brand and Terminal are grouped with
 * their nearer existing code (Brand under Tenant, mirroring how Brand
 * itself is a "tenant-level object" per D-01; Terminal under Branch, since
 * it has no permission tier of its own and the RBAC lattice itself has no
 * terminal scope — see `PlatformSettingsScopeTargetResolver`'s docblock).
 */
@ApiTags('platform-settings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('platform/settings')
export class PlatformSettingsController {
  constructor(
    private readonly resolver: SettingsResolverService,
    private readonly inspector: SettingsInspectorService,
    private readonly admin: SettingsAdminService,
  ) {}

  @Get('resolve')
  @AuthorizationTarget(
    resourceOrTenantTarget(
      PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER,
      {
        terminalId: fromQuery('terminalId', true),
        branchId: fromQuery('branchId', true),
        brandId: fromQuery('brandId', true),
      },
      'the deepest of brandId/branchId/terminalId supplied, else tenant',
      'Not found.',
    ),
  )
  @RequireAnyPermission(
    ORGANISATION_PERMISSIONS.TENANT_READ,
    ORGANISATION_PERMISSIONS.BRANCH_READ,
  )
  @ApiOkResponse({
    description: 'The FR-PLT-025 effective value and lock metadata.',
  })
  async resolve(
    @CurrentTenantContext() context: TenantContext,
    @Query() query: ResolveSettingsQueryDto,
  ) {
    const result = await this.resolver.resolveEffective(context.tenantId, {
      settingKey: query.settingKey,
      brandId: query.brandId,
      branchId: query.branchId,
      terminalId: query.terminalId,
    });
    return toEffectiveSettingView(result);
  }

  @Get('inspect')
  @AuthorizationTarget(
    resourceOrTenantTarget(
      PLATFORM_SETTINGS_SCOPE_TARGET_RESOLVER,
      {
        terminalId: fromQuery('terminalId', true),
        branchId: fromQuery('branchId', true),
        brandId: fromQuery('brandId', true),
      },
      'the deepest of brandId/branchId/terminalId supplied, else tenant',
      'Not found.',
    ),
  )
  @RequireAnyPermission(
    ORGANISATION_PERMISSIONS.TENANT_READ,
    ORGANISATION_PERMISSIONS.BRANCH_READ,
  )
  @ApiOkResponse({ description: 'The FR-PLT-027 level-by-level breakdown.' })
  async inspect(
    @CurrentTenantContext() context: TenantContext,
    @Query() query: ResolveSettingsQueryDto,
  ) {
    const result = await this.inspector.inspect(context.tenantId, {
      settingKey: query.settingKey,
      brandId: query.brandId,
      branchId: query.branchId,
      terminalId: query.terminalId,
    });
    return toInspectorView(result);
  }

  @Put('tenant/:settingKey')
  @AuthorizationTarget(tenantTarget('Tenant-level setting administration.'))
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.OK)
  async upsertTenant(
    @CurrentTenantContext() context: TenantContext,
    @Param('settingKey') settingKey: string,
    @Body() dto: UpsertSettingValueDto,
  ) {
    const record = await this.admin.upsert(
      context.tenantId,
      context.userId,
      'tenant',
      context.tenantId,
      settingKey,
      dto.value,
      dto.locked,
    );
    return toSettingValueView(record);
  }

  @Delete('tenant/:settingKey')
  @AuthorizationTarget(tenantTarget('Tenant-level setting administration.'))
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsetTenant(
    @CurrentTenantContext() context: TenantContext,
    @Param('settingKey') settingKey: string,
  ) {
    await this.admin.unset(
      context.tenantId,
      context.userId,
      'tenant',
      context.tenantId,
      settingKey,
    );
  }

  @Put('brand/:brandId/:settingKey')
  @AuthorizationTarget(brandFromParam('brandId'))
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.OK)
  async upsertBrand(
    @CurrentTenantContext() context: TenantContext,
    @Param('brandId') brandId: string,
    @Param('settingKey') settingKey: string,
    @Body() dto: UpsertSettingValueDto,
  ) {
    const record = await this.admin.upsert(
      context.tenantId,
      context.userId,
      'brand',
      brandId,
      settingKey,
      dto.value,
      dto.locked,
    );
    return toSettingValueView(record);
  }

  @Delete('brand/:brandId/:settingKey')
  @AuthorizationTarget(brandFromParam('brandId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsetBrand(
    @CurrentTenantContext() context: TenantContext,
    @Param('brandId') brandId: string,
    @Param('settingKey') settingKey: string,
  ) {
    await this.admin.unset(
      context.tenantId,
      context.userId,
      'brand',
      brandId,
      settingKey,
    );
  }

  @Put('branch/:branchId/:settingKey')
  @AuthorizationTarget(branchFromParam('branchId'))
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @HttpCode(HttpStatus.OK)
  async upsertBranch(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
    @Param('settingKey') settingKey: string,
    @Body() dto: UpsertSettingValueDto,
  ) {
    const record = await this.admin.upsert(
      context.tenantId,
      context.userId,
      'branch',
      branchId,
      settingKey,
      dto.value,
      dto.locked,
    );
    return toSettingValueView(record);
  }

  @Delete('branch/:branchId/:settingKey')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsetBranch(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
    @Param('settingKey') settingKey: string,
  ) {
    await this.admin.unset(
      context.tenantId,
      context.userId,
      'branch',
      branchId,
      settingKey,
    );
  }

  @Put('terminal/:terminalId/:settingKey')
  @AuthorizationTarget(
    resourceTarget(
      IDENTITY_TERMINAL_TARGET_RESOLVER,
      { terminalId: fromParam('terminalId') },
      'the branch owning this terminal',
      'Terminal not found.',
    ),
  )
  @Idempotent()
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @HttpCode(HttpStatus.OK)
  async upsertTerminal(
    @CurrentTenantContext() context: TenantContext,
    @Param('terminalId') terminalId: string,
    @Param('settingKey') settingKey: string,
    @Body() dto: UpsertSettingValueDto,
  ) {
    const record = await this.admin.upsert(
      context.tenantId,
      context.userId,
      'terminal',
      terminalId,
      settingKey,
      dto.value,
      dto.locked,
    );
    return toSettingValueView(record);
  }

  @Delete('terminal/:terminalId/:settingKey')
  @AuthorizationTarget(
    resourceTarget(
      IDENTITY_TERMINAL_TARGET_RESOLVER,
      { terminalId: fromParam('terminalId') },
      'the branch owning this terminal',
      'Terminal not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsetTerminal(
    @CurrentTenantContext() context: TenantContext,
    @Param('terminalId') terminalId: string,
    @Param('settingKey') settingKey: string,
  ) {
    await this.admin.unset(
      context.tenantId,
      context.userId,
      'terminal',
      terminalId,
      settingKey,
    );
  }
}
