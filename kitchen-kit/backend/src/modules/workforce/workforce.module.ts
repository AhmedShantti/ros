import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { SHIFT_OPENER } from './contract';
import { ShiftsService } from './shifts/shifts.service';

/**
 * Workforce bounded context — MINIMAL, by ratification.
 *
 * Carried item P1D-A reopens D-2's Workforce defer for one thing: the
 * Operational Shift the POS/Treasury critical path needs. Schedule, the schedule
 * builder, ScheduledShift, AttendanceRecord, clock events, breaks, overtime,
 * leave, shift swaps, payroll, compensation and labour forecasting all remain
 * deferred and have no representation here.
 *
 * NO CONTROLLER. FR-POS-090 frames shift opening as a CASHIER action taken while
 * opening a drawer, and that is the command Treasury exposes. A separate public
 * "open a shift" route would invent an operation no source describes and would
 * let a shift exist with no cash session, which is a state nothing in this slice
 * can act on. The service is reached through `SHIFT_OPENER`.
 *
 * PUBLIC SURFACE: `contract/` only. SRS §5.4 makes `modules/<context>/contract/`
 * the sole directory another module may import, and §5.2.3 requires that rule to
 * be enforced mechanically rather than by convention —
 * `src/modules/module-boundaries.spec.ts` is that enforcement. `ShiftsService`
 * and the Shift row are private and are reached only through `SHIFT_OPENER`.
 *
 * `shift.opened` (SRS §5.5.4) is NOT published: the repository has no
 * transactional outbox, and faking a fire-and-forget event would be worse than
 * the honest gap. The contract command takes the caller's transaction so the
 * event can be recorded there later without redesign.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ShiftsService,
    { provide: SHIFT_OPENER, useExisting: ShiftsService },
  ],
  exports: [ShiftsService, SHIFT_OPENER],
})
export class WorkforceModule {}
