import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { CurrentPrincipal } from '../identity/auth/decorators/current-principal.decorator';
import { AllowPosSession } from '../identity/auth/decorators/pos-session.decorator';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipal } from '../identity/auth/auth.types';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import { CashMovementsService } from './cash-movements/cash-movements.service';
import { CashSessionsService } from './cash-sessions/cash-sessions.service';
import { CashMovementDto, OpenCashSessionDto } from './treasury.dto';
import { TREASURY_PERMISSIONS } from './treasury.permissions';
import {
  toCashMovementView,
  toCashSessionView,
  toShiftView,
} from './treasury.views';

/**
 * Treasury API — cash session OPEN, plus P1G-0's mid-shift cash movements.
 *
 * Route surface, following how `/orders`, `/recipes`, `/inventory` and
 * `/catalogue` map SRS §26.3 (the documented `/v1` prefix is applied at
 * deployment, not in the controller):
 *
 *   POST /cash-sessions                          open a cashier shift + its cash session
 *   POST /cash-sessions/{sessionId}/pay-in        FR-POS-091 — record cash in
 *   POST /cash-sessions/{sessionId}/pay-out       FR-POS-091 — record cash out
 *   POST /cash-sessions/{sessionId}/safe-drop     FR-POS-091 — remove excess cash to the safe
 *
 * ── WHY THREE SEPARATE ROUTES, NOT ONE `/movements` WITH `type` IN THE BODY ─
 * `@RequirePermission` is a route-level static decorator evaluated by a guard
 * BEFORE the handler runs; it cannot inspect the request body to pick a
 * permission. A single collapsed route would force either one coarse
 * permission (inventing one — forbidden) or body-dependent authorization (a
 * new guard capability, and a security anti-pattern). Three routes give a
 * 1:1 permission mapping and an unambiguous audit/OpenAPI surface (design
 * gate §9).
 *
 * ── WHY THERE IS NO `GET /cash-sessions/:id` OR ANY MOVEMENT READ ROUTE ─────
 * §15.2 quotes `cash.session.open` as "Open a shift" — a WRITE authority. It is
 * not a generic CashSession read permission, and reinterpreting it as one would
 * hand every session-opening cashier a read capability no source grants. The
 * same reasoning excludes a movement-read route: §15.2's Cash group contains
 * only `cash.session.open`, `cash.session.close`, `cash.session.close_other`,
 * `cash.drawer.open_no_sale`, `cash.payin` / `cash.payout`, `cash.safedrop`,
 * `cash.variance.approve` and `cash.day.close` — no read code for either. §15.2
 * designates Appendix C as the authoritative full catalogue, and **Appendix C
 * is ABSENT from ROS_SRS_v1.0.pdf** — the document ends at §29.5. That is not
 * a new finding: ratified decision **D-20** records the same absence and
 * answers it the same way, by DEFERRING the permission code rather than
 * inventing one.
 *
 * So the read routes are withdrawn rather than misauthorised. No permission is
 * invented (`cash.session.read`, `cash.movement.read`, `cash.movement.manage`),
 * no existing code is repurposed, and no unguarded read is exposed.
 * `CashSessionsService.findOne` and the P1G-0
 * `CASH_MOVEMENT_TOTALS_QUERY` module contract remain INTERNAL — the totals
 * contract exists precisely so a future Cash Close (P1G-1) can read movement
 * totals without any HTTP surface at all.
 *
 * ── DELIBERATELY ABSENT ─────────────────────────────────────────────────────
 *   GET  /cash-sessions/:id               · no source-supported read authority.
 *   GET  .../movements                    · no source-supported read authority.
 *   POST /cash-sessions/:id/close         · FR-POS-094/096 require a physical
 *                                            count, blind by default, and
 *                                            FR-FIN-006 requires independent
 *                                            variance approval. No approval
 *                                            subsystem exists, and `ros_app`
 *                                            holds no UPDATE on the table —
 *                                            closing is not merely unrouted,
 *                                            it is impossible.
 *   drawer-limit enforcement / prompt     · FR-POS-092 — all four of its
 *                                            parameters (source of truth,
 *                                            level, default, prompt-vs-block)
 *                                            are undecided (design gate §5).
 *                                            The three movement routes exist;
 *                                            no limit is enforced on them.
 *   any correction/reversal endpoint      · NOT SOURCE-DECIDABLE (design
 *                                            gate §12) — no UPDATE/DELETE, no
 *                                            compensating-movement shortcut.
 *   X report                              · FR-POS-093, authorization NOT
 *                                            SOURCE-DECIDABLE (no
 *                                            `cash.x_report`, `report.view.
 *                                            <category>` unenumerated).
 *   drawer administration                 · no SRS endpoint and no §15.2
 *                                            permission exists;
 *                                            `cash.session.open` is NOT
 *                                            repurposed as a drawer-admin
 *                                            authority.
 *   payment capture                       · `pos.payment.capture` is
 *                                            authorised (carried item P1D-F)
 *                                            but has no route and is not
 *                                            seeded.
 *
 * Guard chain: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). A cross-tenant id is invisible under RLS and yields
 * 404, never 403.
 *
 * `@AllowPosSession` opts this route in for PIN-issued sessions (FR-SEC-021);
 * every other route still refuses them by default.
 *
 * ── FR-SEC-028 SCOPE NOTE ───────────────────────────────────────────────────
 * Every route here requires a registered, unrevoked terminal, so terminal
 * registration / revocation enforcement is COMPLETE on this controller. That
 * is a statement about this controller only. FR-SEC-028 [M] requires BOTH
 * immediate credential invalidation AND wiping the terminal's local data on
 * next contact; the second half needs an offline local store that does not
 * exist, so the requirement is GLOBALLY **PARTIAL** — as
 * `docs/reconciliation/PHASE_1_SRS_REQUIREMENT_MAP.md` already records. No
 * route in this controller closes it.
 */

// Shapes verified against `toCashSessionView`/`toShiftView` in
// `treasury.views.ts` — not against the Prisma schema or the SRS.
const cashSessionSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    drawerId: uuidSchema(),
    shiftId: uuidSchema(),
    employeeId: uuidSchema(),
    openingFloat: moneyStringSchema(),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    status: { type: 'string', enum: ['open', 'closed'] },
    openedAt: isoDateTimeSchema(),
    closedAt: nullable(isoDateTimeSchema()),
  },
};

const shiftSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    employeeId: uuidSchema(),
    status: { type: 'string', enum: ['open', 'closed'] },
    openedAt: isoDateTimeSchema(),
  },
};

// Shape verified against `toCashMovementView` in `treasury.views.ts`.
const cashMovementSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    cashSessionId: uuidSchema(),
    branchId: uuidSchema(),
    employeeId: uuidSchema(),
    movementType: {
      type: 'string',
      enum: ['pay_in', 'pay_out', 'safe_drop'],
    },
    amountMinor: moneyStringSchema(
      'Positive minor-unit amount as a decimal string. The route (not this field) decides the sign.',
    ),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code — the cash session’s own currency.',
      example: 'AED',
    },
    reason: { type: 'string' },
    occurredAt: isoDateTimeSchema(),
  },
};

@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@AllowPosSession()
@Controller('cash-sessions')
export class TreasuryController {
  constructor(
    private readonly sessions: CashSessionsService,
    private readonly movements: CashMovementsService,
  ) {}

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
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description:
      'The opened cash session and its shift, plus whether this call created them (false on an idempotent replay of an already-open pair).',
    schema: {
      type: 'object',
      properties: {
        cashSession: cashSessionSchema,
        shift: shiftSchema,
        created: { type: 'boolean' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Missing/over-long Idempotency-Key, a non-ULID shiftId/cashSessionId/drawerId, shiftId equal to cashSessionId, or an otherwise invalid request body.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown terminal, branch, or employee.',
  })
  @ApiConflictResponse({
    description:
      'The terminal or employee is not active, or the Idempotency-Key was already used with a different request body / is still in flight.',
  })
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

  /** Record cash added to the drawer — FR-POS-091 [M]. */
  @Post(':sessionId/pay-in')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.CASH_PAYIN)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The recorded pay-in movement.',
    schema: cashMovementSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/malformed id, a non-positive amountMinor, a blank reason, or an otherwise invalid request body.',
  })
  @ApiNotFoundResponse({ description: 'Unknown cash session or terminal.' })
  @ApiConflictResponse({
    description:
      'The cash session is not open, or the movement id already exists with different content (FR-OFF-015).',
  })
  async payIn(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId') sessionId: string,
    @Body() dto: CashMovementDto,
  ) {
    const { movement } = await this.movements.payIn(
      context.tenantId,
      context.userId,
      this.toMovementInput(principal, sessionId, dto),
    );
    return toCashMovementView(movement);
  }

  /** Record cash removed from the drawer for an expense — FR-POS-091 [M]. */
  @Post(':sessionId/pay-out')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.CASH_PAYOUT)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The recorded pay-out movement.',
    schema: cashMovementSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/malformed id, a non-positive amountMinor, a blank reason, or an otherwise invalid request body.',
  })
  @ApiNotFoundResponse({ description: 'Unknown cash session or terminal.' })
  @ApiConflictResponse({
    description:
      'The cash session is not open, or the movement id already exists with different content (FR-OFF-015).',
  })
  async payOut(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId') sessionId: string,
    @Body() dto: CashMovementDto,
  ) {
    const { movement } = await this.movements.payOut(
      context.tenantId,
      context.userId,
      this.toMovementInput(principal, sessionId, dto),
    );
    return toCashMovementView(movement);
  }

  /** Record excess cash removed to the safe — FR-POS-091 [M]. */
  @Post(':sessionId/safe-drop')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @RequirePermission(TREASURY_PERMISSIONS.CASH_SAFEDROP)
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Opaque client-chosen key. A replay with the same key and request body returns the original result unchanged (Idempotent-Replay: true).',
  })
  @ApiCreatedResponse({
    description: 'The recorded safe-drop movement.',
    schema: cashMovementSchema,
  })
  @ApiBadRequestResponse({
    description:
      'Missing/malformed id, a non-positive amountMinor, a blank reason, or an otherwise invalid request body.',
  })
  @ApiNotFoundResponse({ description: 'Unknown cash session or terminal.' })
  @ApiConflictResponse({
    description:
      'The cash session is not open, or the movement id already exists with different content (FR-OFF-015). ' +
      'NOTE: FR-POS-092’s configurable drawer limit is NOT enforced here (design gate §5 — all four of its ' +
      'parameters are undecided).',
  })
  async safeDrop(
    @CurrentTenantContext() context: TenantContext,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('sessionId') sessionId: string,
    @Body() dto: CashMovementDto,
  ) {
    const { movement } = await this.movements.safeDrop(
      context.tenantId,
      context.userId,
      this.toMovementInput(principal, sessionId, dto),
    );
    return toCashMovementView(movement);
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

  /**
   * The terminal and employee come from the SESSION, never the body — same
   * requirement as `requirePosIdentity`. `sessionId` is the route param;
   * `cashSessionId` has no field in `CashMovementDto` for a caller to supply
   * a different one.
   */
  private toMovementInput(
    principal: AuthenticatedPrincipal,
    sessionId: string,
    dto: CashMovementDto,
  ) {
    const { terminalId, employeeId } = this.requirePosIdentity(principal);
    return {
      id: dto.id,
      cashSessionId: sessionId,
      amountMinor: dto.amountMinor,
      reason: dto.reason,
      occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined,
      employeeId,
      terminalId,
    };
  }
}
