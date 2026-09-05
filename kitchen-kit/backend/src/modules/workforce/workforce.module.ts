import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { SHIFT_OPENER } from './contract';
import {
  WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER,
  WORKFORCE_EMPLOYEE_TARGET_RESOLVER,
  WORKFORCE_SCHEDULE_TARGET_RESOLVER,
} from './contract';
import { ShiftsService } from './shifts/shifts.service';
import { EmployeesController } from './employees/employees.controller';
import { WorkforceEmployeesService } from './employees/employees.service';
import { EmployeeTargetResolver } from './employees/employee-target.resolver';
import { ScheduleController } from './schedule/schedule.controller';
import { ScheduleService } from './schedule/schedule.service';
import { ScheduleTargetResolver } from './schedule/schedule-target.resolver';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import { AttendanceCorrectionService } from './attendance/attendance-correction.service';
import { AttendanceSettingsService } from './attendance/attendance-settings.service';
import { AttendanceRecordTargetResolver } from './attendance/attendance-target.resolver';

/**
 * Workforce bounded context.
 *
 * Carried item P1D-A authorises Operational Shift (below, `SHIFT_OPENER`) —
 * UNCHANGED by HR-1. HR-1 (this task) reopens the REST of P1D-1's "still
 * deferred" list narrowly further: the full Employee record (FR-HRM-001..
 * 006), Schedule/ScheduledShift (FR-HRM-010/012), and Attendance/ClockEvent
 * (FR-HRM-020..025). Leave, shift swaps, labour forecasting, performance
 * metrics (FR-HRM-030..032) and payroll export (FR-HRM-035/036) remain
 * deferred and have no representation here — see the HR-1 report.
 *
 * `IdentityModule` is imported for the SAME cross-cutting HTTP/auth plumbing
 * every other HTTP module in this repository already imports it for
 * (`JwtAuthGuard`, `PermissionGuard`, `TenantContextGuard`, `AllowPosSession`,
 * `CurrentPrincipal`) — see `module-boundaries.spec.ts`'s
 * `KNOWN_DEVIATIONS['workforce->identity']`.
 */
@Module({
  imports: [PrismaModule, AuditModule, IdentityModule],
  controllers: [EmployeesController, ScheduleController, AttendanceController],
  providers: [
    ShiftsService,
    { provide: SHIFT_OPENER, useExisting: ShiftsService },

    WorkforceEmployeesService,
    EmployeeTargetResolver,
    {
      provide: WORKFORCE_EMPLOYEE_TARGET_RESOLVER,
      useExisting: EmployeeTargetResolver,
    },

    ScheduleService,
    ScheduleTargetResolver,
    {
      provide: WORKFORCE_SCHEDULE_TARGET_RESOLVER,
      useExisting: ScheduleTargetResolver,
    },

    AttendanceService,
    AttendanceCorrectionService,
    AttendanceSettingsService,
    AttendanceRecordTargetResolver,
    {
      provide: WORKFORCE_ATTENDANCE_RECORD_TARGET_RESOLVER,
      useExisting: AttendanceRecordTargetResolver,
    },
  ],
  exports: [ShiftsService, SHIFT_OPENER, WorkforceEmployeesService],
})
export class WorkforceModule {}
