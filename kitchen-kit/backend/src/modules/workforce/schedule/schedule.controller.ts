import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Idempotent } from '../../../common/idempotency/idempotent.decorator';
import {
  AuthorizationTarget,
  branchFromBody,
  fromParam,
  resourceTarget,
} from '../../identity/contract/authorization-target';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { WORKFORCE_SCHEDULE_TARGET_RESOLVER } from '../contract';
import { WORKFORCE_PERMISSIONS } from '../workforce.permissions';
import {
  CreateScheduleDto,
  CreateScheduledShiftDto,
} from '../employees/employees.dto';
import {
  scheduleSchema,
  scheduleWithShiftsSchema,
  scheduledShiftSchema,
} from '../workforce.openapi';
import { ScheduleService } from './schedule.service';

const scheduleResourceTarget = () =>
  resourceTarget(
    WORKFORCE_SCHEDULE_TARGET_RESOLVER,
    { scheduleId: fromParam('scheduleId') },
    'The schedule owns a real branch_id; the branch is never in the path.',
    'Schedule not found.',
  );

@ApiTags('workforce-schedules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('workforce/schedules')
export class ScheduleController {
  constructor(private readonly schedules: ScheduleService) {}

  /** FR-HRM-010 — create a schedule by branch and week. */
  @Post()
  @AuthorizationTarget(branchFromBody('branchId'))
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE)
  @ApiCreatedResponse({ schema: scheduleSchema })
  create(
    @CurrentTenantContext() context: TenantContext,
    @Body() dto: CreateScheduleDto,
  ) {
    return this.schedules.createSchedule(
      context.tenantId,
      context.userId,
      dto.branchId,
      new Date(dto.weekStartDate),
    );
  }

  @Get(':scheduleId')
  @AuthorizationTarget(scheduleResourceTarget())
  @RequirePermission(WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE)
  @ApiOkResponse({ schema: scheduleWithShiftsSchema })
  async get(
    @CurrentTenantContext() context: TenantContext,
    @Param('scheduleId') scheduleId: string,
  ) {
    const schedule = await this.schedules.getSchedule(
      context.tenantId,
      scheduleId,
    );
    if (!schedule) {
      throw new NotFoundException('Schedule not found.');
    }
    return schedule;
  }

  /** FR-HRM-010/012 — create one validated scheduled shift. */
  @Post(':scheduleId/shifts')
  @AuthorizationTarget(scheduleResourceTarget())
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.SCHEDULE_MANAGE)
  @ApiCreatedResponse({ schema: scheduledShiftSchema })
  createShift(
    @CurrentTenantContext() context: TenantContext,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: CreateScheduledShiftDto,
  ) {
    return this.schedules.createScheduledShift(
      context.tenantId,
      context.userId,
      scheduleId,
      {
        employeeId: dto.employeeId,
        position: dto.position,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
      },
    );
  }
}
