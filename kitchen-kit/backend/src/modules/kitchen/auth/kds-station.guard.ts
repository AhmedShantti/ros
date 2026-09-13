import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { UUID_PATTERN } from '../../../common/ids';
import type {
  AuthenticatedPrincipal,
  RequestAuthorization,
  ScopeTargetResolver,
} from '../../identity/contract';
import { ORG_STATION_TARGET_RESOLVER } from '../../organisation/contract';
import { PrismaService } from '../../../prisma/prisma.service';

export interface KdsStation {
  readonly stationId: string;
  readonly branchId: string;
}

export type KdsAuthorizedRequest = Request & {
  principal?: AuthenticatedPrincipal;
  authorization?: RequestAuthorization;
  kdsStation?: KdsStation;
};

/**
 * CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13) — REPLACES the former
 * terminal + exactly-one-station gate (KDS operator-lifecycle acceptance
 * correction §3.3/§4). KDS is a branch/employee-scoped application SESSION,
 * not a registered device identity: there is no terminal to derive a
 * station binding from any more. Runs after `JwtAuthGuard` (401) ->
 * `TenantContextGuard` (403, and — load-bearing here — the point where
 * `request.authorization.context.branchId` is populated, live-verified, for
 * a `kds` session) -> `PermissionGuard` (`kds.operate`, 403).
 *
 * Checks, in order, each independently fail-closed:
 *   1. the session is a KDS session at all (`principal.sessionType ===
 *      'kds'`) — POS and dashboard sessions are refused here even though
 *      `JwtAuthGuard`'s `@AllowKdsSession()` gate already only lets `kds`
 *      sessions reach this controller; restated because this guard is the
 *      one place `request.kdsStation` gets its trust;
 *   2. the session has a live-verified operating branch
 *      (`TenantContextService.resolveSessionBranch` already re-checked the
 *      employee's permitted branches this request — see `tenant-context
 *      .service.ts`);
 *   3. a `stationId` is present — from the `:stationId` path parameter on
 *      station-scoped routes, or a `?stationId=` query parameter on
 *      ticket-scoped routes (Kitchen §13: "stationId in URL/body/query");
 *   4. the station exists, and belongs to the SAME branch the session
 *      operates in (Organisation's published `ORG_STATION_TARGET_RESOLVER`
 *      — never a direct Kitchen read of Organisation's private
 *      `org.stations` table).
 *
 * Deliberately UNLIKE the former guard: no "exactly one station" cardinality
 * check exists any more — that was a property of a single registered
 * terminal display, and multiple browsers/devices may legitimately target
 * the SAME KDS station now (no device registration at all). `kds.operate`
 * does NOT carry station scope (KDS-R11) — this guard is where ACT-09
 * ("Kitchen Staff | One station | KDS") is actually enforced, per-request,
 * from the caller-supplied station rather than a device binding.
 *
 * On success, `request.kdsStation` is populated so the controller/service
 * layer never re-derives it (and, for ticket-scoped routes, uses it to
 * verify the TICKET's own station matches —
 * `KdsOperationsService.loadTicketOwnedByStation`).
 */
@Injectable()
export class KdsStationGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ORG_STATION_TARGET_RESOLVER)
    private readonly stationTarget: ScopeTargetResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<KdsAuthorizedRequest>();
    const principal = request.principal;
    if (principal?.sessionType !== 'kds') {
      throw new ForbiddenException('KDS operations require a KDS session.');
    }
    const tenantId = principal.tenantId;
    const branchId = request.authorization?.context.branchId;
    if (!tenantId || !branchId) {
      throw new ForbiddenException(
        'This KDS session has no resolved operating branch.',
      );
    }

    const pathStationId = (request.params as Record<string, string> | undefined)
      ?.stationId;
    const queryStationId = (
      request.query as Record<string, unknown> | undefined
    )?.stationId;
    const stationId =
      pathStationId ??
      (typeof queryStationId === 'string' ? queryStationId : undefined);
    if (!stationId) {
      throw new ForbiddenException(
        'A stationId is required for this KDS operation.',
      );
    }
    if (!UUID_PATTERN.test(stationId)) {
      throw new ForbiddenException('stationId must be a UUID.');
    }
    if (pathStationId !== undefined && queryStationId !== undefined) {
      // A route that carries a path station must never additionally accept
      // a DIFFERENT one via query — ambiguity must never resolve in the
      // caller's favour.
      throw new ForbiddenException(
        'stationId may be supplied via the path or a query parameter, never both.',
      );
    }

    const target = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.stationTarget.resolve(tx, { tenantId, keys: { stationId } }),
    );
    if (!target || target.type !== 'branch' || target.branchId !== branchId) {
      throw new ForbiddenException(
        'This station is not available to this KDS session.',
      );
    }

    request.kdsStation = { stationId, branchId: target.branchId };
    return true;
  }
}
