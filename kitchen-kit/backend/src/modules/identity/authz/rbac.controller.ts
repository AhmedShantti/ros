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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
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
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { RequirePermission } from './decorators/require-permission.decorator';
import { AddPermissionsDto } from './dto/add-permissions.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { PermissionGuard } from './guards/permission.guard';
import { MembershipRolesService } from './membership-roles.service';
import { IDENTITY_PERMISSIONS } from './permissions.constants';
import { RolesService } from './roles.service';

// Shape verified against the `Role` Prisma model — `listForTenant`/
// `createTenantRole` in `roles.service.ts` return it directly, with no
// separate view/factory function (nothing on it is sensitive).
const roleSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: nullable(
      uuidSchema('NULL for a platform/system role, shared across tenants.'),
    ),
    name: { type: 'string' },
    description: nullable({ type: 'string' }),
    isSystem: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
  },
};

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
    private readonly audit: AuditService,
  ) {}

  /** Effective permissions of the caller's active membership. */
  @Get('permissions')
  @ApiOkResponse({
    description: "The caller's effective permission codes, sorted.",
    schema: {
      type: 'object',
      properties: { permissions: { type: 'array', items: { type: 'string' } } },
    },
  })
  myPermissions(@CurrentAuthorization() auth: RequestAuthorization): {
    permissions: string[];
  } {
    return { permissions: [...auth.permissions].sort() };
  }

  @Get('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_READ)
  @ApiOperation({
    summary:
      'Roles visible to the tenant: its own roles plus shared system roles.',
  })
  @ApiOkResponse({
    description: 'Roles, system roles first, then by name.',
    schema: { type: 'array', items: roleSchema },
  })
  listRoles(@CurrentTenantContext() ctx: TenantContext) {
    return this.roles.listForTenant(ctx.tenantId);
  }

  @Post('roles')
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_CREATE)
  @ApiOperation({ summary: 'Create a tenant-owned role.' })
  @ApiCreatedResponse({
    description: 'The newly created role.',
    schema: roleSchema,
  })
  @ApiConflictResponse({
    description: 'A role with this name already exists in this tenant.',
  })
  createRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateRoleDto,
  ) {
    return this.roles.createTenantRole(ctx.tenantId, dto);
  }

  @Post('roles/:roleId/permissions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_UPDATE)
  @ApiOperation({ summary: 'Grant permissions to a tenant-owned role.' })
  @ApiNoContentResponse({ description: 'Permissions granted.' })
  @ApiBadRequestResponse({
    description: 'An unknown permission code was given.',
  })
  @ApiNotFoundResponse({
    description: 'The role does not exist in this tenant.',
  })
  @ApiForbiddenResponse({
    description: 'The role is a system role and cannot be modified.',
  })
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
  @ApiOperation({ summary: 'Assign a role to a membership.' })
  @ApiNoContentResponse({ description: 'Role assigned.' })
  @ApiNotFoundResponse({
    description: 'The membership or role does not exist in this tenant.',
  })
  @ApiForbiddenResponse({
    description: 'The role is a system role and cannot be assigned here.',
  })
  async assignRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleDto,
  ): Promise<void> {
    await this.membershipRoles.assign(ctx.tenantId, membershipId, dto.roleId);
    await this.audit.emit({
      tenantId: ctx.tenantId,
      action: AUDIT_ACTION.ROLE_ASSIGNED,
      entityType: AUDIT_ENTITY.MEMBERSHIP,
      actorType: 'user',
      actorId: ctx.userId,
      entityId: membershipId,
      terminalId: ctx.terminalId ?? null,
      metadata: { roleId: dto.roleId },
    });
  }

  @Delete('memberships/:membershipId/roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({ summary: 'Remove a role from a membership.' })
  @ApiNoContentResponse({ description: 'Role removed.' })
  @ApiNotFoundResponse({
    description: 'The membership does not exist in this tenant.',
  })
  async removeRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.membershipRoles.remove(ctx.tenantId, membershipId, roleId);
  }
}
