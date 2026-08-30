import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { OrganisationModule } from '../organisation/organisation.module';
import { WorkforceModule } from '../workforce/workforce.module';
import { CashClosePolicyController } from './cash-close-policy/cash-close-policy.controller';
import { CashClosePolicyResolver } from './cash-close-policy/cash-close-policy.resolver';
import { CashClosePolicyService } from './cash-close-policy/cash-close-policy.service';
import { CashMovementTotalsQueryService } from './cash-movements/cash-movement-totals.query.service';
import { CashMovementsService } from './cash-movements/cash-movements.service';
import { CashSessionFactsQueryService } from './cash-sessions/cash-session-facts.query.service';
import { CashSessionsService } from './cash-sessions/cash-sessions.service';
import {
  CASH_MOVEMENT_TOTALS_QUERY,
  CASH_SESSION_FACTS_QUERY,
} from './contract';
import { DrawersService } from './drawers/drawers.service';
import { TreasuryController } from './treasury.controller';

/**
 * Treasury bounded context — Drawer + CashSession OPEN.
 *
 * PUBLIC HTTP SURFACE: ONE route — open a cashier shift with its cash
 * session. Nothing else. There is no read ROUTE: `cash.session.open` is
 * §15.2's WRITE authority ("Open a shift") and no CashSession read code
 * exists to use instead,
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
 *
 * P1F-1 adds the FIRST published `contract/` QUERY: `CASH_SESSION_FACTS_QUERY`
 * (`modules/treasury/contract`), consumed by Sales' Payment capture to
 * validate P1D-G attribution. Still no public read ROUTE — the contract is
 * an in-process module boundary, not HTTP.
 *
 * P1G-0 adds mid-shift cash movements (FR-POS-091): three routes
 * (`pay-in`/`pay-out`/`safe-drop`), the append-only `cash_movements` ledger,
 * and a SECOND `contract/` query, `CASH_MOVEMENT_TOTALS_QUERY`, for a future
 * Cash Close (P1G-1) to read movement totals inside its own close
 * transaction — again no public read ROUTE, since §15.2 names no
 * movement-read permission. FR-POS-092's drawer limit is deliberately NOT
 * implemented (design gate §5 — all four parameters undecided).
 *
 * P1G-1 migration 33 adds the cash-close POLICY substrate (FR-FIN-006
 * tolerance, FR-POS-094/095 count mode, R-4(a) approval-expiry duration): a
 * THIRD controller-visible route, `POST /branches/:branchId/cash-close-policy`
 * on the SEPARATE `CashClosePolicyController` (a dashboard/back-office route,
 * not a POS-session one), plus a Treasury-PRIVATE resolver
 * (`CashClosePolicyResolver`, `cash-close-policy/`) — NOT a `contract/`
 * export, because the only consumer this slice has is Treasury itself
 * (design gate §9.1). CashSession Close itself is NOT implemented by this
 * migration; the resolver exists for a future P1G-1 close to consume.
 *
 * `OrganisationModule` is imported for the acceptance-closure correction:
 * `CashClosePolicyService` needs a branch's authoritative base currency, and
 * `org.branches` is Organisation-owned data (SRS §5.2.3 — a module MUST NOT
 * query another module's tables, and a direct `tx.branch.*` query would have
 * violated that even though no PRIVATE Organisation file is imported). The
 * ONLY thing imported is `organisation/contract`'s `BRANCH_CURRENCY_QUERY`
 * token, the published `BranchCurrencyQuery` interface —
 * `module-boundaries.spec.ts` allows importing `modules/<other>/contract`
 * and `modules/<other>/<other>.module` unconditionally (SRS §5.4), so this
 * is not a `KNOWN_DEVIATIONS` entry.
 */
@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    AuditModule,
    WorkforceModule,
    OrganisationModule,
  ],
  controllers: [TreasuryController, CashClosePolicyController],
  providers: [
    DrawersService,
    CashSessionsService,
    CashSessionFactsQueryService,
    CashMovementsService,
    CashMovementTotalsQueryService,
    CashClosePolicyService,
    CashClosePolicyResolver,
    {
      provide: CASH_SESSION_FACTS_QUERY,
      useExisting: CashSessionFactsQueryService,
    },
    {
      provide: CASH_MOVEMENT_TOTALS_QUERY,
      useExisting: CashMovementTotalsQueryService,
    },
  ],
  exports: [
    DrawersService,
    CashSessionsService,
    CASH_SESSION_FACTS_QUERY,
    CASH_MOVEMENT_TOTALS_QUERY,
    // P1G-1: exported so a future CashSession Close slice (this module) can
    // inject the resolver directly. NOT a `contract/` token — Treasury-only.
    CashClosePolicyResolver,
  ],
})
export class TreasuryModule {}
