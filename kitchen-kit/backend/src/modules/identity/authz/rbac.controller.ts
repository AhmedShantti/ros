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
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthorizationService } from './authorization.service';
import { IDENTITY_PERMISSIONS } from './permissions.constants';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AddPermissionsDto } from './dto/add-permissions.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { PermissionGuard } from './guards/permission.guard';
import { MembershipRolesService } from './membership-roles.service';
import { RolesService } from './roles.service';

// JwtAuthGuard (401) runs before PermissionGuard (403) for every route.
@ApiTags('rbac')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('auth')
export class RbacController {
  constructor(
    private readonly roles: RolesService,
    private readonly membershipRoles: MembershipRolesService,
    private readonly authz: AuthorizationService,
  ) {}

  /** Effective permissions of the caller's active membership ([] if none). */
  @Get('permissions')
  async myPermissions(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ permissions: string[] }> {
    const codes = await this.authz.getEffectivePermissions(principal);
    return { permissions: [...codes].sort() };
  }

  @Get('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_READ)
  @ApiForbiddenResponse({ description: 'Insufficient permission.' })
  listRoles(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.roles.listForTenant(principal.tenantId!);
  }

  @Post('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_CREATE)
  @ApiForbiddenResponse({ description: 'Insufficient permission.' })
  createRole(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roles.createTenantRole(principal.tenantId!, dto);
  }

  @Post('roles/:roleId/permissions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_UPDATE)
  @ApiForbiddenResponse({
    description: 'Insufficient permission / system role.',
  })
  async addRolePermissions(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('roleId') roleId: string,
    @Body() dto: AddPermissionsDto,
  ): Promise<void> {
    await this.roles.addPermissions(
      principal.tenantId!,
      roleId,
      dto.permissionCodes,
    );
  }

  @Post('memberships/:membershipId/roles')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiForbiddenResponse({
    description: 'Insufficient permission / system role.',
  })
  async assignRole(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<void> {
    await this.membershipRoles.assign(
      principal.tenantId!,
      membershipId,
      dto.roleId,
    );
  }

  @Delete('memberships/:membershipId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiForbiddenResponse({ description: 'Insufficient permission.' })
  async removeRole(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('membershipId') membershipId: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.membershipRoles.remove(
      principal.tenantId!,
      membershipId,
      roleId,
    );
  }
}
