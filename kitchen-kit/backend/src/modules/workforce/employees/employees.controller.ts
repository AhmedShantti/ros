import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import {
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  branchFromBody,
  branchFromQueryOrTenant,
  fromParam,
  resourceTarget,
} from '../../identity/contract/authorization-target';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { AssignmentScopeDto, AssignRoleDto } from '../../identity/authz/dto/assign-role.dto';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import type { AssignmentScopeInput } from '../../identity/authz/membership-roles.service';
import { IDENTITY_PERMISSIONS } from '../../identity/authz/permissions.constants';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { PinService } from '../../identity/employees/pin.service';
import { WORKFORCE_EMPLOYEE_TARGET_RESOLVER } from '../contract';
import { WORKFORCE_PERMISSIONS } from '../workforce.permissions';
import {
  compensationSchema,
  employeeBranchSchema,
  employeeSchema,
} from '../workforce.openapi';
import {
  AddPermittedBranchDto,
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  SetCompensationDto,
  SetEmployeePinDto,
  UpdateEmployeeDto,
} from './employees.dto';
import { WorkforceEmployeesService } from './employees.service';

// Shape verified against `MembershipRolesService`'s `AssignmentView`
// (`toAssignmentBody` in `rbac.controller.ts`), plus `roleName` — the one
// enrichment this facade adds so the Employees UI never needs a second
// round trip to `GET /auth/roles` just to label a dropdown.
const roleAssignmentSchema = {
  type: 'object',
  properties: {
    id: uuidSchema('Stable assignment identity (FR-SEC-003).'),
    membershipId: uuidSchema(),
    roleId: uuidSchema(),
    roleName: nullable({ type: 'string' }),
    scopeType: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    scopeBrandId: nullable(uuidSchema('Set iff scopeType = brand.')),
    scopeBranchId: nullable(uuidSchema('Set iff scopeType = branch.')),
    validFrom: isoDateTimeSchema(),
    validTo: nullable(isoDateTimeSchema()),
    origin: { type: 'string', enum: ['explicit', 'migration'] },
    reviewedAt: nullable(isoDateTimeSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

/**
 * DEMO-EMPLOYEE-RBAC-1 — map the validated scope DTO onto the domain scope
 * union. Mirrors `RbacController`'s own private `toAssignmentScope` exactly
 * (same fail-closed checks) — that function is not exported, so this is a
 * small, deliberate duplication of a pure ~15-line mapper rather than a new
 * cross-controller import; the actual assignment logic it feeds
 * (`MembershipRolesService.create`) is reused verbatim, never duplicated.
 */
function toAssignmentScope(dto: AssignmentScopeDto): AssignmentScopeInput {
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

const employeeResourceTarget = () =>
  resourceTarget(
    WORKFORCE_EMPLOYEE_TARGET_RESOLVER,
    { employeeId: fromParam('employeeId') },
    'The employee owns a real home_branch_id; the branch is never in the path.',
    'Employee not found.',
  );

@ApiTags('workforce-employees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('workforce/employees')
export class EmployeesController {
  constructor(
    private readonly employees: WorkforceEmployeesService,
    private readonly pin: PinService,
  ) {}

  /** FR-HRM-001/002/005 — create a full employee record. */
  @Post()
  @AuthorizationTarget(branchFromBody('homeBranchId'))
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  @ApiCreatedResponse({
    schema: {
      ...employeeSchema,
      properties: {
        ...employeeSchema.properties,
        permittedBranchIds: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  create(
    @CurrentTenantContext() context: TenantContext,
    @Body() dto: CreateEmployeeDto,
  ) {
    return this.employees.create(context.tenantId, context.userId, dto);
  }

  @Get()
  @AuthorizationTarget(branchFromQueryOrTenant('branchId'))
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW)
  @ApiOkResponse({ schema: { type: 'array', items: employeeSchema } })
  list(
    @CurrentTenantContext() context: TenantContext,
    @Query('branchId') branchId?: string,
  ) {
    return this.employees.list(context.tenantId, branchId);
  }

  @Get(':employeeId')
  @AuthorizationTarget(employeeResourceTarget())
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW)
  @ApiOkResponse({ schema: employeeSchema })
  async get(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
  ) {
    const employee = await this.employees.get(context.tenantId, employeeId);
    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }
    return employee;
  }

  /** FR-HRM-003 — restricted to `hr.compensation.view` holders only. */
  @Get(':employeeId/compensation')
  @AuthorizationTarget(employeeResourceTarget())
  @RequirePermission(WORKFORCE_PERMISSIONS.COMPENSATION_VIEW)
  @ApiOkResponse({
    schema: nullable(compensationSchema),
    description:
      'The current compensation version, or null if none has ever been set.',
  })
  async currentCompensation(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
  ) {
    const row = await this.employees.currentCompensation(
      context.tenantId,
      employeeId,
    );
    if (!row) return null;
    // `amount_minor_units` is a Postgres BIGINT → JS `bigint`, which
    // `JSON.stringify` cannot serialize. Exact minor units as a STRING on
    // the wire, mirroring `CreateCashClosePolicyDto`'s own money convention
    // (never a float on either side of this boundary).
    return { ...row, amountMinorUnits: row.amountMinorUnits.toString() };
  }

  @Patch(':employeeId')
  @AuthorizationTarget(employeeResourceTarget())
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiOkResponse({ schema: employeeSchema })
  update(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employees.update(
      context.tenantId,
      context.userId,
      employeeId,
      dto,
    );
  }

  /** FR-HRM-006 — deactivate, never hard-delete. */
  @Post(':employeeId/deactivate')
  @AuthorizationTarget(employeeResourceTarget())
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiCreatedResponse({ schema: employeeSchema })
  deactivate(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: DeactivateEmployeeDto,
  ) {
    return this.employees.deactivate(
      context.tenantId,
      context.userId,
      employeeId,
      dto,
    );
  }

  /** FR-HRM-005 — multi-branch assignment. */
  @Post(':employeeId/branches')
  @AuthorizationTarget(employeeResourceTarget())
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiCreatedResponse({ schema: employeeBranchSchema })
  addBranch(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: AddPermittedBranchDto,
  ) {
    return this.employees.addPermittedBranch(
      context.tenantId,
      context.userId,
      employeeId,
      dto.branchId,
    );
  }

  /**
   * LIVE-DEMO-HOTFIX-1 — set/rotate this employee's POS PIN through the real
   * Workforce Employees surface. Thin passthrough to the existing
   * `PinService.setPin` (identity/employees) — no logic duplicated here, and
   * `PinService.authenticate`'s verification path is completely untouched.
   */
  @Post(':employeeId/pin')
  @AuthorizationTarget(employeeResourceTarget())
  @HttpCode(HttpStatus.NO_CONTENT)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  async setPin(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: SetEmployeePinDto,
  ): Promise<void> {
    await this.pin.setPin(context.tenantId, context.userId, employeeId, dto.pin);
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — this employee's scoped role assignments. A thin
   * facade: the Employees UI knows only `employeeId`, never the raw
   * `membershipId` `POST /auth/memberships/{membershipId}/roles` addresses —
   * `WorkforceEmployeesService.listRoleAssignments` resolves that link and
   * delegates entirely to the existing `MembershipRolesService`.
   */
  @Get(':employeeId/role-assignments')
  @AuthorizationTarget(employeeResourceTarget())
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_READ)
  @ApiOkResponse({
    description: "This employee's assignments, oldest first.",
    schema: { type: 'array', items: roleAssignmentSchema },
  })
  listRoleAssignments(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
  ) {
    return this.employees.listRoleAssignments(context.tenantId, employeeId);
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — assign a role to this employee at an EXPLICIT
   * scope. Same `AssignRoleDto`/`AssignmentScopeDto` shape
   * `POST /auth/memberships/{membershipId}/roles` already accepts — no
   * parallel contract. Delegates to `MembershipRolesService.create`, which
   * performs the atomic scoped-assignment insert + `authzEpoch` bump + audit
   * write; nothing is reimplemented here.
   */
  @Post(':employeeId/role-assignments')
  @AuthorizationTarget(employeeResourceTarget())
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged.',
  })
  @ApiCreatedResponse({
    description: 'The created assignment.',
    schema: roleAssignmentSchema,
  })
  assignRole(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: AssignRoleDto,
  ) {
    return this.employees.assignRoleToEmployee(
      context.tenantId,
      context.userId,
      employeeId,
      { roleId: dto.roleId, scope: toAssignmentScope(dto.scope) },
    );
  }

  /**
   * DEMO-EMPLOYEE-RBAC-1 — remove ONE of this employee's role assignments.
   * `WorkforceEmployeesService.removeRoleAssignment` confirms the assignment
   * actually belongs to this employee before delegating to
   * `MembershipRolesService.remove`.
   */
  @Delete(':employeeId/role-assignments/:assignmentId')
  @AuthorizationTarget(employeeResourceTarget())
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(IDENTITY_PERMISSIONS.ROLE_ASSIGN)
  async removeRoleAssignment(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Param('assignmentId') assignmentId: string,
  ): Promise<void> {
    await this.employees.removeRoleAssignment(
      context.tenantId,
      context.userId,
      employeeId,
      assignmentId,
    );
  }

  /**
   * FR-HRM-003 — a new effective-dated version. No `hr.compensation.manage`
   * code exists in §15.2 (only `.view`); writing pay is therefore gated on
   * `hr.employee.manage`, the same "no write verb given" discipline
   * `SALES_PERMISSIONS` documents for `pos.order.create`.
   */
  @Post(':employeeId/compensation')
  @AuthorizationTarget(employeeResourceTarget())
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_MANAGE)
  @ApiCreatedResponse({ schema: compensationSchema })
  async setCompensation(
    @CurrentTenantContext() context: TenantContext,
    @Param('employeeId') employeeId: string,
    @Body() dto: SetCompensationDto,
  ) {
    const row = await this.employees.setCompensation(
      context.tenantId,
      context.userId,
      employeeId,
      {
        basis: dto.basis,
        amountMinorUnits: BigInt(dto.amountMinorUnits),
        currency: dto.currency,
        effectiveFrom: dto.effectiveFrom,
      },
    );
    return { ...row, amountMinorUnits: row.amountMinorUnits.toString() };
  }
}
