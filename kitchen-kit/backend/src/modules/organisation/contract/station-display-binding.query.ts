import { Prisma } from '../../../generated/prisma/client';

/**
 * Organisation PUBLIC contract — KDS operator-lifecycle acceptance correction
 * §3.3, ACT-09 ("Kitchen Staff | One station | KDS").
 *
 * `org.stations.display_terminal_id` (ADR 0008 D-16) is the only fact that
 * binds a physical KDS terminal to the station(s) it displays. Kitchen must
 * not query `org.stations` directly (§5.2.3) — this is the one door through,
 * mirroring `RoutingConfigQuery`'s split between Organisation-owned storage
 * and a Kitchen-consumed public interface.
 *
 * Deliberately returns every station bound to the terminal, not "the"
 * station: the acceptance correction's exactly-one-station RULE (0 ⇒ 403,
 * >1 ⇒ 403, fail-closed) is Kitchen's own authorization decision to make, not
 * something this query should decide by silently picking one.
 */
export const STATION_DISPLAY_BINDING_QUERY = Symbol(
  'STATION_DISPLAY_BINDING_QUERY',
);

export interface StationDisplayBinding {
  readonly stationId: string;
  readonly branchId: string;
}

export interface StationDisplayBindingQuery {
  stationsForTerminal(
    tx: Prisma.TransactionClient,
    terminalId: string,
  ): Promise<readonly StationDisplayBinding[]>;
}
