import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentAuthorization,
  CurrentTenantContext,
} from '../context/current-tenant-context.decorator';
import type {
  RequestAuthorization,
  TenantContext,
} from '../context/tenant-context';
import { TenantContextGuard } from '../context/tenant-context.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AddPermissionsDto } from './dto/add-permissions.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { PermissionGuard } from './guards/permission.guard';
import { MembershipRolesService } from './membership-roles.service';
import { IDENTITY_PERMISSIONS } from './permissions.constants';
import { RolesService } from './roles.service';

// Guard order: JwtAuthGuard (401) → TenantContextGuard (403, establishes the
// trusted context once) → PermissionGuard (403, consumes it).
@ApiTags('rbac')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('auth')
export class RbacController {
  constructor(
    private readonly roles: RolesService,
    private readonly membershipRoles: MembershipRolesService,
  ) {}

  /** Effective permissions of the caller's active membership. */
  @Get('permissions')
  myPermissions(@CurrentAuthorization() auth: RequestAuthorization): {
    permissions: string[];
  } {
    return { permissions: [...auth.permissions].sort() };
  }

  @Get('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_READ)
  listRoles(@CurrentTenantContext() ctx: TenantContext) {
    return this.roles.listForTenant(ctx.tenantId);
  }

  @Post('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_CREATE)
  createRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roles.createTenantRole(ctx.tenantId, dto);
  }

  @Post('roles/:roleId/permissions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_UPDATE)
  async addRolePermissions(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('roleId') roleId: string,
    @Body() dto: AddPermissionsDto,
  ): Promise<void> {
    await this.roles.addPermissions(ctx.tenantId, roleId, dto.permissionCodes);
  }

  @Post('memberships/:membershipId/roles')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  async assignRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<void> {
    await this.membershipRoles.assign(ctx.tenantId, membershipId, dto.roleId);
  }

  @Delete('memberships/:membershipId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  async removeRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.membershipRoles.remove(ctx.tenantId, membershipId, roleId);
  }
}
