import {
  Body,
  Controller,
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
import { nullable } from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  branchFromBody,
  branchFromQueryOrTenant,
  fromParam,
  resourceTarget,
} from '../../identity/contract/authorization-target';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
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
