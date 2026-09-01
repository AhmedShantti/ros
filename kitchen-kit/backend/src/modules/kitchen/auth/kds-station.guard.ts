import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { TERMINAL_FACTS_QUERY } from '../../identity/contract';
import type {
  AuthenticatedPrincipal,
  TerminalFactsQuery,
} from '../../identity/contract';
import { STATION_DISPLAY_BINDING_QUERY } from '../../organisation/contract';
import type { StationDisplayBindingQuery } from '../../organisation/contract';
import { PrismaService } from '../../../prisma/prisma.service';

export interface KdsStation {
  readonly stationId: string;
  readonly branchId: string;
}

export type KdsAuthorizedRequest = Request & {
  principal?: AuthenticatedPrincipal;
  kdsStation?: KdsStation;
};

/**
 * KDS operator-lifecycle acceptance correction §3.3/§4 — the fail-closed
 * terminal + exactly-one-station gate every KDS route requires, INCLUDING
 * the read-only GET queue. Runs after `JwtAuthGuard` (401) ->
 * `TenantContextGuard` (403) -> `PermissionGuard` (`kds.operate`, 403).
 *
 * Checks, in order, each independently fail-closed:
 *   1. the session is terminal-bound at all (`principal.terminalId`);
 *   2. the terminal exists, is `active`, and is `terminalType === 'kds'`
 *      (Identity's `TerminalFactsQuery` — never a direct Identity table read);
 *   3. the terminal is bound to EXACTLY ONE station
 *      (Organisation's `StationDisplayBindingQuery`) — 0 or >1 both 403,
 *      fail-closed, never an arbitrarily chosen station;
 *   4. when the route names a `:stationId` path parameter, it MUST equal the
 *      terminal-derived station — never a client-trusted value on its own.
 *
 * `kds.operate` does NOT carry station scope (KDS-R11) — this guard is where
 * ACT-09 ("Kitchen Staff | One station | KDS") is actually enforced. On
 * success, `request.kdsStation` is populated so the controller/service layer
 * never re-derives it (and, for ticket-scoped routes with no `:stationId`
 * path parameter, uses it to verify the TICKET's own station matches —
 * `KdsOperationsService.loadTicketOwnedByStation`).
 */
@Injectable()
export class KdsStationGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
    @Inject(STATION_DISPLAY_BINDING_QUERY)
    private readonly stationBinding: StationDisplayBindingQuery,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<KdsAuthorizedRequest>();
    const principal = request.principal;
    if (!principal?.terminalId) {
      throw new ForbiddenException(
        'KDS operations require a terminal-bound session.',
      );
    }
    const tenantId = principal.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No active tenant context.');
    }
    const terminalId = principal.terminalId;

    const station = await this.prisma.withAuthContext(
      { tenantId },
      async (tx) => {
        const terminal = await this.terminalFacts.getById(tx, terminalId);
        if (
          !terminal ||
          terminal.status !== 'active' ||
          terminal.terminalType !== 'kds'
        ) {
          throw new ForbiddenException(
            'KDS operations require an active, KDS-type terminal.',
          );
        }
        const stations = await this.stationBinding.stationsForTerminal(
          tx,
          terminalId,
        );
        if (stations.length === 0) {
          throw new ForbiddenException(
            'This terminal is not configured as a KDS station display.',
          );
        }
        if (stations.length > 1) {
          throw new ForbiddenException(
            'This terminal is bound to more than one station, which is unsupported in this release.',
          );
        }
        return stations[0];
      },
    );

    const pathStationId = (request.params as Record<string, string> | undefined)
      ?.stationId;
    if (pathStationId !== undefined && pathStationId !== station.stationId) {
      throw new ForbiddenException(
        'This terminal is not the display for the requested station.',
      );
    }

    request.kdsStation = station;
    return true;
  }
}
