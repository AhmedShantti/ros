import {
  Body,
  Controller,
  ForbiddenException,
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
import { AllowPosSession } from '../../identity/auth/decorators/pos-session.decorator';
import { CurrentPrincipal } from '../../identity/auth/decorators/current-principal.decorator';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../../identity/auth/auth.types';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import {
  AuthorizationTarget,
  branchFromBody,
  fromParam,
  resourceTarget,
} from '../../identity/contract/authorization-target';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER } from '../contract';
import { WORKFORCE_PERMISSIONS } from '../workforce.permissions';
import {
  ClockInDto,
  ClockOutDto,
  CorrectAttendanceDto,
  SetAttendanceSettingsDto,
} from '../employees/employees.dto';
import {
  attendanceCorrectionSchema,
  attendanceRecordSchema,
  attendanceRecordWithHistorySchema,
  attendanceSettingsSchema,
} from '../workforce.openapi';
import { AttendanceCorrectionService } from './attendance-correction.service';
import { AttendanceSettingsService } from './attendance-settings.service';
import { AttendanceService } from './attendance.service';

const attendanceResourceTarget = () =>
  resourceTarget(
    WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER,
    { attendanceRecordId: fromParam('attendanceRecordId') },
    'The attendance record owns a real branch_id; the branch is never in the path.',
    'Attendance record not found.',
  );

@ApiTags('workforce-attendance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('workforce/attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly corrections: AttendanceCorrectionService,
    private readonly settings: AttendanceSettingsService,
  ) {}

  private requirePosIdentity(principal: AuthenticatedPrincipal): {
    terminalId: string;
    employeeId: string;
  } {
    if (!principal.terminalId || !principal.employeeId) {
      throw new ForbiddenException(
        'Clocking in/out requires a terminal-bound POS session that identifies the employee (FR-SEC-021).',
      );
    }
    return {
      terminalId: principal.terminalId,
      employeeId: principal.employeeId,
    };
  }

  /**
   * FR-HRM-020/021/022/023 — POS-terminal PIN clock-in.
   *
   * NO `@RequirePermission`: the caller acts on their OWN employment record
   * via a PIN-verified POS session, never on an RBAC grant — every active
   * employee must be able to clock themselves in regardless of what else
   * they are permitted to do. §15.2's Workforce catalogue has no "clock in"
   * verb to invent one from. See `REVIEWED_UNPROTECTED_ROUTES` in
   * `authorization-coverage.spec.ts`.
   */
  @Post('clock-in')
  @AllowPosSession()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @ApiCreatedResponse({ schema: attendanceRecordSchema })
  async clockIn(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: ClockInDto,
  ) {
    const { terminalId, employeeId } = this.requirePosIdentity(principal);
    const branchId = context.branchId;
    if (!branchId) {
      throw new ForbiddenException(
        'Clocking in requires a terminal-bound session with a resolved operating branch.',
      );
    }
    return this.attendance.clockIn(context.tenantId, context.userId, {
      employeeId,
      branchId,
      terminalId,
      gps: dto.gps,
    });
  }

  /** FR-HRM-020/021/022 — POS-terminal PIN clock-out. Same authority as clock-in. */
  @Post('clock-out')
  @AllowPosSession()
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ schema: attendanceRecordSchema })
  async clockOut(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: ClockOutDto,
  ) {
    const { terminalId, employeeId } = this.requirePosIdentity(principal);
    return this.attendance.clockOut(context.tenantId, context.userId, {
      employeeId,
      terminalId,
      gps: dto.gps,
    });
  }

  @Get(':attendanceRecordId')
  @AuthorizationTarget(attendanceResourceTarget())
  @RequirePermission(WORKFORCE_PERMISSIONS.EMPLOYEE_VIEW)
  @ApiOkResponse({ schema: attendanceRecordWithHistorySchema })
  async get(
    @CurrentTenantContext() context: TenantContext,
    @Param('attendanceRecordId') attendanceRecordId: string,
  ) {
    const record = await this.attendance.get(
      context.tenantId,
      attendanceRecordId,
    );
    if (!record) {
      throw new NotFoundException('Attendance record not found.');
    }
    return record;
  }

  /** FR-HRM-025 — manual correction: permission-gated, reasoned, evidenced. */
  @Post(':attendanceRecordId/correct')
  @AuthorizationTarget(attendanceResourceTarget())
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(WORKFORCE_PERMISSIONS.ATTENDANCE_CORRECT)
  @ApiCreatedResponse({ schema: attendanceCorrectionSchema })
  correct(
    @CurrentTenantContext() context: TenantContext,
    @Param('attendanceRecordId') attendanceRecordId: string,
    @Body() dto: CorrectAttendanceDto,
  ) {
    return this.corrections.correct(
      context.tenantId,
      context.userId,
      attendanceRecordId,
      {
        field: dto.field,
        correctedValue: new Date(dto.correctedValue),
        reason: dto.reason,
      },
    );
  }

  /**
   * FR-HRM-022/023 threshold configuration — a NEW effective-dated version.
   * `settings.branch.manage` ("Branch configuration"), NOT an HR code: the
   * exact `treasury/cash-close-policy` precedent for reusing this
   * already-seeded Organisation permission for a new per-branch policy
   * table, declared as a plain string literal to avoid a new
   * `workforce->organisation` private-path import.
   */
  @Post('settings')
  @AuthorizationTarget(branchFromBody('branchId'))
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission('settings.branch.manage')
  @ApiCreatedResponse({ schema: attendanceSettingsSchema })
  setSettings(
    @CurrentTenantContext() context: TenantContext,
    @Body() dto: SetAttendanceSettingsDto,
  ) {
    return this.settings.set(context.tenantId, context.userId, {
      branchId: dto.branchId,
      graceMinutes: dto.graceMinutes,
      earlyClockInMinutes: dto.earlyClockInMinutes,
      geofenceCenterLat: dto.geofenceCenterLat,
      geofenceCenterLng: dto.geofenceCenterLng,
      geofenceRadiusMeters: dto.geofenceRadiusMeters,
      ...(dto.effectiveFrom
        ? { effectiveFrom: new Date(dto.effectiveFrom) }
        : {}),
    });
  }
}
