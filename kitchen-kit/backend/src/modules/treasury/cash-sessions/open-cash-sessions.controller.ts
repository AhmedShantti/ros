import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import { JwtAuthGuard } from '../../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../../identity/context/tenant-context';
import { TenantContextGuard } from '../../identity/context/tenant-context.guard';
import { AuthorizationTarget, branchFromParam } from '../../identity/contract';
import { TREASURY_PERMISSIONS } from '../treasury.permissions';
import { toOpenCashSessionView } from '../treasury.views';
import { CashSessionsService } from './cash-sessions.service';

const openCashSessionSchema = {
  type: 'object',
  properties: {
    sessionId: uuidSchema(),
    branchId: uuidSchema(),
    drawerId: uuidSchema(),
    drawerName: { type: 'string' },
    employeeId: uuidSchema(),
    employeeName: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closing'] },
    openedAt: isoDateTimeSchema(),
    openingFloat: moneyStringSchema(),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
  },
};

/**
 * Manager cash-session DISCOVERY — DEMO-MANAGER-CASH-SESSIONS-P0.
 *
 * A DASHBOARD/back-office route (no `@AllowPosSession`, mirroring
 * `CashClosePolicyController`/`DrawersController` exactly): `TreasuryController`
 * carries `@AllowPosSession()` at the CLASS level with no route-level
 * "un-opt" mechanism anywhere in this codebase, so a manager-only read
 * cannot live there without becoming PIN/POS-session-reachable too. This is
 * a SEPARATE controller for exactly that reason, on the SAME `/branches/...`
 * resource family `DrawersController`/`CashClosePolicyController` already
 * established for branch-scoped Treasury administration reads, not nested
 * under `/cash-sessions` (a POS-operation resource family).
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 * Manager close-other (`GET .../close-context`, `POST .../close`,
 * `POST .../close/finalize` on `TreasuryController`, gated on
 * `cash.session.close_other`) already exists and is fully correct — proven
 * by `cash-session-close.e2e-spec.ts`'s "own/other authority" suite. What
 * was missing was DISCOVERY: no route returned the `sessionId` a manager
 * needs to call any of those three with, for a session that is not their
 * own. A cashier who loses their local `cashSessionId` and cannot recover it
 * through `GET /cash-sessions/current` (a different employee's session, a
 * different terminal, a wiped device) had no path to a manager unblocking
 * them at all.
 *
 * ── PERMISSION: `cash.session.close_other`, NOT A NEW CODE ─────────────────
 * §15.2 quotes `cash.session.close_other` as "Close another user's shift" —
 * this route is its READ HALF, exactly as `GET /cash-sessions/current` is
 * the read half of `cash.session.open` (`treasury.controller.ts`'s own
 * docblock). A caller who may close another employee's session at a branch
 * may see which sessions exist to close; a caller who may not is refused
 * enumeration entirely (never a silently-filtered empty list masquerading as
 * "nothing to see"). No permission is invented, `cash.session.open` is not
 * reinterpreted as a manager-wide read, and `Cashier` is not widened —
 * `cash.session.close_other` is deliberately withheld from Cashier already
 * (`canonical-role-templates.ts`).
 *
 * ── BRANCH SCOPE ────────────────────────────────────────────────────────
 * `branchId` is a client-supplied path param, exactly like
 * `GET /branches/:branchId/drawers` — but `@AuthorizationTarget
 * (branchFromParam('branchId'))` resolves it through `PermissionGuard`
 * BEFORE the handler runs: invisible/cross-tenant -> 404, visible but not
 * covered by the caller's own branch grants -> 403. The client never gets to
 * simply assert a branchId and be trusted; `CashSessionsService
 * .listOpenForBranch` re-checks branch existence again itself, mirroring
 * `DrawersService.listForBranch`'s own defense-in-depth precedent.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────
 * No `closed` sessions (nothing left to discover once reconciled). No
 * tenant-wide listing (branch-scoped only, via the path param). No
 * force-close/force-delete — the ONLY way to act on a returned `sessionId`
 * is the EXISTING close-other workflow this route feeds into; no second
 * close endpoint is added.
 */
@ApiTags('treasury')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('branches')
export class OpenCashSessionsController {
  constructor(private readonly sessions: CashSessionsService) {}

  @Get(':branchId/cash-sessions/open')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(TREASURY_PERMISSIONS.CASH_SESSION_CLOSE_OTHER)
  @ApiOkResponse({
    description:
      'Every OPEN or CLOSING cash session at this branch, oldest first — ' +
      'enough to identify and act on a stranded session through the ' +
      'existing close-other workflow (close-context / close / close/finalize).',
    schema: { type: 'array', items: openCashSessionSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  async listOpenSessions(
    @CurrentTenantContext() context: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    const rows = await this.sessions.listOpenForBranch(
      context.tenantId,
      branchId,
    );
    return rows.map(toOpenCashSessionView);
  }
}
