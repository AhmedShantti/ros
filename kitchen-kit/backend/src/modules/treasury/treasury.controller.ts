import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { CurrentPrincipal } from '../identity/auth/decorators/current-principal.decorator';
import { AllowPosSession } from '../identity/auth/decorators/pos-session.decorator';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../identity/auth/auth.types';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import { CashSessionsService } from './cash-sessions/cash-sessions.service';
import { OpenCashSessionDto } from './treasury.dto';
import { TREASURY_PERMISSIONS } from './treasury.permissions';
import { toCashSessionView, toShiftView } from './treasury.views';

/**
 * Treasury API — cash session OPEN only.
 *
 * Route surface, following how `/orders`, `/recipes`, `/inventory` and
 * `/catalogue` map SRS §26.3 (the documented `/v1` prefix is applied at
 * deployment, not in the controller):
 *
 *   POST /cash-sessions        open a cashier shift + its cash session
 *
 * That is the WHOLE public surface. There is exactly one route.
 *
 * ── WHY THERE IS NO `GET /cash-sessions/:id` ────────────────────────────────
 * §15.2 quotes `cash.session.open` as "Open a shift" — a WRITE authority. It is
 * not a generic CashSession read permission, and reinterpreting it as one would
 * hand every session-opening cashier a read capability no source grants.
 *
 * No CashSession read code exists to use instead. §15.2's Cash group contains
 * only `cash.session.open`, `cash.session.close`, `cash.session.close_other`,
 * `cash.drawer.open_no_sale`, `cash.payin` / `cash.payout`, `cash.safedrop`,
 * `cash.variance.approve` and `cash.day.close`. §15.2 designates Appendix C as
 * the authoritative full catalogue, and **Appendix C is ABSENT from
 * ROS_SRS_v1.0.pdf** — the document ends at §29.5. That is not a new finding:
 * ratified decision **D-20** records the same absence and answers it the same
 * way, by DEFERRING the permission code rather than inventing one.
 *
 * So the read route is withdrawn rather than misauthorised. `cash.session.read`
 * is not invented, `cash.session.close` is not repurposed, no report permission
 * is borrowed, and no unguarded read is exposed. `CashSessionsService.findOne`
 * remains as an INTERNAL query for the future Payment / Treasury slices, which
 * is where a read authority will become source-decidable.
 *
 * ── DELIBERATELY ABSENT ─────────────────────────────────────────────────────
 *   GET  /cash-sessions/:id         · no source-supported read authority; see
 *                                     above.
 *   POST /cash-sessions/:id/close   · FR-POS-094/096 require a physical count,
 *                                     blind by default, and FR-FIN-006 requires
 *                                     independent variance approval. No approval
 *                                     subsystem exists, and `ros_app` holds no
 *                                     UPDATE on the table — closing is not
 *                                     merely unrouted, it is impossible.
 *   pay-in / pay-out / safe drop    · FR-POS-091/092, not in this slice.
 *   X report                        · FR-POS-093.
 *   drawer administration           · no SRS endpoint and no §15.2 permission
 *                                     exists; `cash.session.open` is NOT
 *                                     repurposed as a drawer-admin authority.
 *   payment capture                 · `pos.payment.capture` is authorised
 *                                     (carried item P1D-F) but has no route and
 *                                     is not seeded.
 *
 * Guard chain: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). A cross-tenant id is invisible under RLS and yields
 * 404, never 403.
 *
 * `@AllowPosSession` opts this route in for PIN-issued sessions (FR-SEC-021);
 * every other route still refuses them by default.
 *
 * ── FR-SEC-028 SCOPE NOTE ───────────────────────────────────────────────────
 * The session behind this route must belong to a REGISTERED, unrevoked terminal,
 * so terminal registration / revocation enforcement is COMPLETE on this path.
 * That is a statement about this path only. FR-SEC-028 [M] requires BOTH
 * immediate credential invalidation AND wiping the terminal's local data on next
 * contact; the second half needs an offline local store that does not exist, so
 * the requirement is GLOBALLY **PARTIAL** — as
 * `docs/reconciliation/PHASE_1_SRS_REQUIREMENT_MAP.md` already records. No route
 * in this slice closes it.
 */
@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@AllowPosSession()
@Controller('cash-sessions')
export class TreasuryController {
  constructor(private readonly sessions: CashSessionsService) {}

  /**
   * Open a cashier shift and its cash session — FR-POS-090, FR-FIN-001/002.
   *
   * ONE command for the cashier, two records for the model. FR-POS-090
   * describes a single action ("open a shift, declaring an opening float"), and
   * the cashier should not have to know that a shift is a Workforce concept and
   * a session a Treasury one. They stay distinct in the schema (carried item
   * P1D-A); only the command is unified, and both are written in one transaction.
   *
   * `Idempotency-Key` is MANDATORY (FR-API-020): opening a drawer is a
   * financially significant act, and a retry over a flaky link must not produce
   * a second shift or a second session. The two client ULIDs are independent
   * duplicate protection beneath it.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.CASH_SESSION_OPEN)
  async openCashSession(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body() dto: OpenCashSessionDto,
  ) {
    const { terminalId, employeeId } = this.requirePosIdentity(principal);

    const { session, shift, created } = await this.sessions.open(
      context.tenantId,
      context.userId,
      {
        shiftId: dto.shiftId,
        cashSessionId: dto.cashSessionId,
        drawerId: dto.drawerId,
        openingFloat: dto.openingFloat,
        terminalId,
        employeeId,
      },
    );

    return {
      cashSession: toCashSessionView(session),
      shift: toShiftView(shift),
      created,
    };
  }

  // ------------------------------------------------------------- internals

  /**
   * The terminal and the employee come from the SESSION, never from the body.
   *
   * §16.1 requires cash to be attributable to "a person, a shift, and a drawer",
   * and carried item P1D-E makes that person the Employee. A PIN session carries
   * both facts as signed claims; a session without them cannot take custody of a
   * drawer, so the request is refused rather than guessed at.
   */
  private requirePosIdentity(principal: AuthenticatedPrincipal): {
    terminalId: string;
    employeeId: string;
  } {
    if (!principal.terminalId) {
      throw new ForbiddenException(
        'Opening a cash session requires a terminal-bound session.',
      );
    }
    if (!principal.employeeId) {
      throw new ForbiddenException(
        'Opening a cash session requires a session that identifies the employee ' +
          'taking custody of the drawer.',
      );
    }
    return {
      terminalId: principal.terminalId,
      employeeId: principal.employeeId,
    };
  }
}
