import { Controller, ForbiddenException, Get, Inject, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { nullable, uuidSchema } from '../../common/openapi/schema-helpers';
import {
  AllowKdsSession,
  AuthorizationTarget,
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequirePermission,
  sessionBranchTarget,
  TenantContextGuard,
} from '../identity/contract';
import type { TenantContext } from '../identity/contract';
import { STATION_LIST_QUERY } from '../organisation/contract';
import type { StationListQuery } from '../organisation/contract';
import { KDS_PERMISSIONS } from './kitchen.permissions';
import { PrismaService } from '../../prisma/prisma.service';

const stationListItemSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: { type: 'string' },
    displayColour: nullable({ type: 'string' }),
  },
};

/**
 * KDS-STATION-DISCOVERY-AUTH-FIX-P0.
 *
 * Live symptom: the KDS station picker called `GET /org/branches/:branchId
 * /stations` — a back-office route requiring `ORGANISATION_PERMISSIONS
 * .BRANCH_READ`, which a KDS session correctly does not hold (KDS sessions
 * are intentionally refused on generic `/org/*` routes) — and 403'd. This
 * is the KDS-safe replacement: a minimal, read-only picker read scoped to
 * the CALLER'S OWN branch only.
 *
 * Deliberately a SEPARATE controller from `KitchenController`, even though
 * both mount at `/kds`: `KitchenController`'s `KdsStationGuard` is
 * class-level and REQUIRES a `stationId` (path or query) on every route it
 * guards — exactly the thing this endpoint exists to answer BEFORE one has
 * been chosen. Nest has no per-method way to opt a single route out of a
 * class-level `@UseGuards`, so reusing that controller would mean either
 * loosening `KdsStationGuard` itself (not done — the ticket is explicit:
 * do not weaken the KDS restriction) or bolting a stationId-less special
 * case onto a guard whose entire contract is "a stationId is required." A
 * new controller with its own, narrower guard chain is the smaller change.
 *
 * Guard chain: `JwtAuthGuard` (401) -> `TenantContextGuard` (403 — and the
 * point where `TenantContext.branchId` is live-verified for THIS session,
 * `sessionBranchTarget()`'s own contract) -> `PermissionGuard` (`kds
 * .operate`, 403). `@AllowKdsSession()` is what actually excludes POS and
 * dashboard sessions here — the same decorator `KitchenController` and
 * `KdsStationGuard`'s docblock rely on; nothing new is invented. No
 * `KdsStationGuard` on this route: there is no stationId yet to check, and
 * `sessionBranchTarget()` already denies anything without a live-verified
 * KDS session branch, which is the only scope this route ever answers with.
 */
@ApiTags('kitchen')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@RequirePermission(KDS_PERMISSIONS.OPERATE)
@AllowKdsSession()
@Controller('kds')
export class KdsStationsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STATION_LIST_QUERY)
    private readonly stationList: StationListQuery,
  ) {}

  /**
   * The caller's own branch's stations — never a client-supplied
   * tenantId/branchId, never cross-branch. Management fields
   * (`capacityConfig`, `displayTerminalId`) are deliberately absent: this is
   * a picker read, not the Organisation admin surface
   * (`GET /org/branches/:branchId/stations`, unchanged, still `BRANCH_READ`
   * -gated, still console/admin-only).
   */
  @Get('stations')
  @AuthorizationTarget(sessionBranchTarget())
  @ApiOperation({
    summary: "The caller's own branch's kitchen stations, for the KDS station picker.",
  })
  @ApiOkResponse({
    description: 'Stations at this KDS session\'s own branch.',
    schema: { type: 'array', items: stationListItemSchema },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({
    description: 'Not a KDS session, or the session has no live-verified operating branch.',
  })
  async listStations(@CurrentTenantContext() context: TenantContext) {
    if (!context.branchId) {
      throw new ForbiddenException('This route requires a KDS session.');
    }
    return this.prisma.withAuthContext({ tenantId: context.tenantId }, (tx) =>
      this.stationList.listForBranch(tx, {
        tenantId: context.tenantId,
        branchId: context.branchId!,
      }),
    );
  }
}
