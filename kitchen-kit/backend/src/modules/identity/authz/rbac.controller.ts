import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { RequirePermission } from './decorators/require-permission.decorator';
import { AddPermissionsDto } from './dto/add-permissions.dto';
import {
  AssignmentScopeDto,
  AssignRoleDto,
  UpdateAssignmentDto,
} from './dto/assign-role.dto';
import { CreateRoleDto } from './dto/create-role.dto';
import { PermissionGuard } from './guards/permission.guard';
import {
  AssignmentView,
  MembershipRolesService,
} from './membership-roles.service';
import { type AssignmentScope, buildPermittedBranchSet } from './scope';
import { IDENTITY_PERMISSIONS } from './permissions.constants';
import { RolesService } from './roles.service';
import { AuthorizationTarget, tenantTarget } from '../contract';

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

const assignmentSchema = {
  type: 'object',
  properties: {
    id: uuidSchema('Stable assignment identity (FR-SEC-003).'),
    membershipId: uuidSchema(),
    roleId: uuidSchema(),
    scopeType: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    scopeBrandId: nullable(uuidSchema('Set iff scopeType = brand.')),
    scopeBranchId: nullable(uuidSchema('Set iff scopeType = branch.')),
    validFrom: isoDateTimeSchema(),
    validTo: nullable(isoDateTimeSchema()),
    origin: {
      type: 'string',
      enum: ['explicit', 'migration'],
      description:
        'migration = inherited by the B1-2 backfill and not deliberately granted.',
    },
    reviewedAt: nullable(
      isoDateTimeSchema('When an inherited grant was explicitly reviewed.'),
    ),
    createdAt: isoDateTimeSchema(),
  },
};

const effectiveScopeSchema = {
  type: 'object',
  properties: {
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'TENANT-scoped permission codes only — what an unscoped, target-less endpoint authorises today.',
    },
    scopes: {
      type: 'array',
      description: 'Every effective assignment, scope-qualified.',
      items: {
        type: 'object',
        properties: {
          assignmentId: uuidSchema(),
          scopeType: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
          brandId: nullable(uuidSchema()),
          branchId: nullable(uuidSchema()),
          permissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    permittedBranches: {
      type: 'object',
      description:
        'SYMBOLIC permitted-branch set. `all: true` means every branch in the tenant; ' +
        '`all: false` with empty lists means NO branches. Omission never means unrestricted.',
      properties: {
        v: { type: 'integer' },
        all: { type: 'boolean' },
        brands: { type: 'array', items: uuidSchema() },
        branches: { type: 'array', items: uuidSchema() },
      },
    },
    authorizationEpoch: {
      type: 'integer',
      description:
        'Live authorization epoch. A client holding a token minted at an older epoch must refresh.',
    },
    scopeReviewRequired: {
      type: 'boolean',
      description:
        'M-4+ — the tenant still holds unreviewed migration-originated TENANT grants.',
    },
  },
};

/** Map the validated DTO onto the domain scope union. Fails closed on a
 *  mismatch between `type` and the id actually supplied. */
function toAssignmentScope(dto: AssignmentScopeDto): AssignmentScope {
  switch (dto.type) {
    case 'tenant':
      if (dto.brandId || dto.branchId) {
        throw new BadRequestException(
          'A tenant-scoped assignment must not name a brand or a branch.',
        );
      }
      return { type: 'tenant' };
    case 'brand':
      if (!dto.brandId || dto.branchId) {
        throw new BadRequestException(
          'A brand-scoped assignment requires scope.brandId and no scope.branchId.',
        );
      }
      return { type: 'brand', brandId: dto.brandId };
    case 'branch':
      if (!dto.branchId || dto.brandId) {
        throw new BadRequestException(
          'A branch-scoped assignment requires scope.branchId and no scope.brandId.',
        );
      }
      return { type: 'branch', branchId: dto.branchId };
  }
}

function toAssignmentBody(a: AssignmentView) {
  return {
    id: a.id,
    membershipId: a.membershipId,
    roleId: a.roleId,
    scopeType: a.scopeType,
    scopeBrandId: a.scopeBrandId,
    scopeBranchId: a.scopeBranchId,
    validFrom: a.validFrom.toISOString(),
    validTo: a.validTo?.toISOString() ?? null,
    origin: a.origin,
    reviewedAt: a.reviewedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

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

  /**
   * EFFECTIVE-SCOPE READ CONTRACT (amendment clause 19; B1-2 brief §26).
   *
   * The pre-B1-2 shape — `{ permissions: [...] }` — is PRESERVED, so existing
   * clients keep working; everything else is additive. `permissions` now means
   * exactly what it authorises: the TENANT-scoped codes, i.e. what a target-less
   * endpoint accepts today. Scope-qualified authority is in `scopes`.
   *
   * This is PRESENTATION information and is NOT authoritative. `FR-SEC-045`:
   * client-side permission checks are presentation only. A client MUST NOT infer
   * branch authority from a role name, from `EmployeeBranch`, from a home
   * branch, or from a flat permission list — only the server decides, per
   * request, from live scoped assignments.
   *
   * `permittedBranches` is SYMBOLIC on purpose: a tenant-wide actor is one
   * `all: true`, not an expansion of every branch, so this response never grows
   * with the tenant's branch count.
   */
  @Get('permissions')
  @ApiOperation({
    summary:
      "The caller's effective, scope-qualified authority (presentation only).",
  })
  @ApiOkResponse({
    description:
      'Tenant-scoped permission codes, every scoped grant, the symbolic permitted-branch set, the live authorization epoch, and whether inherited-scope review is still outstanding.',
    schema: effectiveScopeSchema,
  })
  myPermissions(@CurrentAuthorization() auth: RequestAuthorization) {
    return {
      permissions: [...auth.permissions].sort(),
      scopes: auth.grants.map((g) => ({
        assignmentId: g.assignmentId,
        scopeType: g.scope.type,
        brandId: g.scope.type === 'brand' ? g.scope.brandId : null,
        branchId: g.scope.type === 'branch' ? g.scope.branchId : null,
        permissions: [...g.permissions].sort(),
      })),
      permittedBranches: buildPermittedBranchSet(
        auth.grants.map((g) => g.scope),
      ),
      authorizationEpoch: auth.authzEpoch,
      scopeReviewRequired: auth.scopeReviewRequired,
    };
  }

  @Get('roles')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
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
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
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
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
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
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary:
      'Assign a role to a membership at an EXPLICIT scope (tenant, brand or branch).',
    description:
      'FR-SEC-002/003/005. `scope` is mandatory — a new assignment is never silently ' +
      'tenant-scoped. The same role may be assigned at several scopes; each is a ' +
      'separate assignment with its own id and its own validity window.',
  })
  @ApiCreatedResponse({
    description: 'The created assignment.',
    schema: assignmentSchema,
  })
  @ApiBadRequestResponse({
    description: 'Scope shape invalid, or validTo not after validFrom.',
  })
  @ApiConflictResponse({
    description:
      'This role is already assigned at this exact scope for an overlapping validity window.',
  })
  @ApiNotFoundResponse({
    description:
      'The membership, role, brand or branch does not exist in this tenant.',
  })
  @ApiForbiddenResponse({
    description: 'The role is a system role and cannot be assigned here.',
  })
  async assignRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Body() dto: AssignRoleDto,
  ) {
    // Audit is written INSIDE the service transaction, atomically with the
    // assignment and the epoch bump — there is no window in which authority has
    // changed but the trail has not.
    const created = await this.membershipRoles.create(
      ctx.tenantId,
      ctx.userId,
      {
        membershipId,
        roleId: dto.roleId,
        scope: toAssignmentScope(dto.scope),
        ...(dto.validFrom ? { validFrom: new Date(dto.validFrom) } : {}),
        ...(dto.validTo !== undefined
          ? { validTo: dto.validTo === null ? null : new Date(dto.validTo) }
          : {}),
      },
    );
    return toAssignmentBody(created);
  }

  @Get('memberships/:membershipId/roles')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_READ)
  @ApiOperation({
    summary: "A membership's scoped role assignments, including expired ones.",
  })
  @ApiOkResponse({
    description: 'Assignments, oldest first.',
    schema: { type: 'array', items: assignmentSchema },
  })
  @ApiNotFoundResponse({
    description: 'The membership does not exist in this tenant.',
  })
  async listAssignments(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
  ) {
    const rows = await this.membershipRoles.listForMembership(
      ctx.tenantId,
      membershipId,
    );
    return rows.map(toAssignmentBody);
  }

  @Patch('role-assignments/:assignmentId')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary: 'Re-scope an assignment and/or change its validity window.',
    description:
      'Both are authority changes: each bumps the membership authorization epoch, so ' +
      'access tokens minted before it are refused until refreshed.',
  })
  @ApiOkResponse({
    description: 'The updated assignment.',
    schema: assignmentSchema,
  })
  @ApiBadRequestResponse({
    description:
      'No change requested, invalid scope shape, or validTo not after validFrom.',
  })
  @ApiConflictResponse({
    description:
      'The requested scope/validity overlaps an existing assignment of the same role at the same scope.',
  })
  @ApiNotFoundResponse({
    description:
      'The assignment, brand or branch does not exist in this tenant.',
  })
  async updateAssignment(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: UpdateAssignmentDto,
  ) {
    const updated = await this.membershipRoles.update(
      ctx.tenantId,
      ctx.userId,
      assignmentId,
      {
        ...(dto.scope ? { scope: toAssignmentScope(dto.scope) } : {}),
        ...(dto.validFrom ? { validFrom: new Date(dto.validFrom) } : {}),
        ...(dto.validTo !== undefined
          ? { validTo: dto.validTo === null ? null : new Date(dto.validTo) }
          : {}),
      },
    );
    return toAssignmentBody(updated);
  }

  @Post('role-assignments/:assignmentId/review')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    summary:
      'Explicitly review an INHERITED (migration-originated) tenant-wide assignment.',
    description:
      'M-4+ outcome A: record that a tenant-wide grant the B1-2 migration inherited is ' +
      'intentionally correct, clearing the review condition WITHOUT forcing a scope ' +
      'change. Outcome B is to re-scope it instead (PATCH). Idempotent: reviewing an ' +
      'already-reviewed assignment changes nothing and does not bump the epoch.',
  })
  @ApiOkResponse({
    description: 'The reviewed assignment.',
    schema: assignmentSchema,
  })
  @ApiBadRequestResponse({
    description: 'The assignment was not migration-originated.',
  })
  @ApiNotFoundResponse({
    description: 'The assignment does not exist in this tenant.',
  })
  async reviewAssignment(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('assignmentId') assignmentId: string,
  ) {
    const reviewed = await this.membershipRoles.review(
      ctx.tenantId,
      ctx.userId,
      assignmentId,
    );
    return toAssignmentBody(reviewed);
  }

  @Delete('role-assignments/:assignmentId')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({ summary: 'Remove ONE scoped assignment by its stable id.' })
  @ApiNoContentResponse({ description: 'Assignment removed.' })
  @ApiNotFoundResponse({
    description: 'The assignment does not exist in this tenant.',
  })
  async removeAssignment(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('assignmentId') assignmentId: string,
  ): Promise<void> {
    await this.membershipRoles.remove(ctx.tenantId, ctx.userId, assignmentId);
  }

  @Delete('memberships/:membershipId/roles/:roleId')
  @AuthorizationTarget(
    tenantTarget(
      'Role and assignment administration is tenant-level: `identity.roles` and `identity.membership_roles` belong to the tenant, and granting authority AT a branch is itself a tenant-level act. Making it branch-targetable would let a branch-scoped actor mint branch-scoped grants — self-elevation by construction.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiOperation({
    deprecated: true,
    summary: 'DEPRECATED — remove a role from a membership by role id.',
    description:
      'Before B1-2 a membership+role pair identified exactly one row. FR-SEC-003 exists ' +
      'so it no longer does. This route therefore FAILS CLOSED with 409 when the role is ' +
      'held at more than one scope, rather than silently revoking several grants. Use ' +
      'DELETE /auth/role-assignments/{assignmentId}.',
  })
  @ApiNoContentResponse({ description: 'Role removed (or already absent).' })
  @ApiConflictResponse({
    description:
      'The role is held at several scopes; remove a specific assignment by its id.',
  })
  @ApiNotFoundResponse({
    description: 'The membership does not exist in this tenant.',
  })
  async removeRole(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('membershipId') membershipId: string,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.membershipRoles.removeByRole(
      ctx.tenantId,
      ctx.userId,
      membershipId,
      roleId,
    );
  }
}
