import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { WorkforceModule } from '../workforce/workforce.module';
import { CashSessionsService } from './cash-sessions/cash-sessions.service';
import { DrawersService } from './drawers/drawers.service';
import { TreasuryController } from './treasury.controller';

/**
 * Treasury bounded context — Drawer + CashSession OPEN.
 *
 * PUBLIC SURFACE: ONE route — open a cashier shift with its cash session.
 * Nothing else. There is no read route: `cash.session.open` is §15.2's WRITE
 * authority ("Open a shift") and no CashSession read code exists to use instead,
 * because §15.2's authoritative Appendix C is absent from the SRS (the same
 * absence ratified decision D-20 records). Close, counted cash, denominations,
 * variance, pay-in/out, safe drop, X report, day close and expenses are all
 * absent too, and `ros_app` holds only SELECT + INSERT on these tables so none of
 * them can be written by accident either.
 *
 * `WorkforceModule` is imported for one PUBLISHED CONTRACT command —
 * `SHIFT_OPENER` from `modules/workforce/contract` (SRS §5.4). The context map
 * routes `Workforce ──▶ Treasury [shift → cash session]`, so Treasury depends on
 * a Workforce contract and Workforce depends on nothing here. Treasury imports
 * no Workforce internal directory; `src/modules/module-boundaries.spec.ts`
 * enforces that mechanically, as SRS §5.2.3 requires.
 *
 * Drawer PROVISIONING has no public route: the SRS defines no drawer-management
 * endpoint and §15.2 no drawer-admin permission, so none is invented and
 * `cash.session.open` is not repurposed as one. `DrawersService` is exported for
 * internal/bootstrap use and the missing operator surface is reported.
 */
@Module({
  imports: [PrismaModule, IdentityModule, AuditModule, WorkforceModule],
  controllers: [TreasuryController],
  providers: [DrawersService, CashSessionsService],
  exports: [DrawersService, CashSessionsService],
})
export class TreasuryModule {}
