import {
  Prisma,
  TerminalStatus,
  TerminalType,
} from '../../../generated/prisma/client';

/**
 * Identity PUBLIC contract — KDS operator-lifecycle acceptance correction §4.
 *
 * A KDS route must fail closed unless the session's bound terminal actually
 * IS an active, `kds`-type terminal — a fact Identity owns
 * (`identity.terminals`) and Kitchen must reach only through this contract,
 * never a direct Prisma query against Identity's private tables.
 *
 * `AuthenticatedPrincipal` carries only `terminalId` today (§4: "terminalType
 * and status are Identity-owned and are not on the token"), so a consumer
 * needing the surface fact must ask Identity for it, per request — this is
 * that ask. Transaction-aware (`Prisma.TransactionClient`), same
 * same-transaction pattern as `organisation/contract`'s `RoutingConfigQuery`
 * (SRS §5.5.1): the caller's own tenant-scoped RLS context already applies,
 * so no `tenantId` parameter is needed here.
 */
export const TERMINAL_FACTS_QUERY = Symbol('TERMINAL_FACTS_QUERY');

export interface TerminalFacts {
  readonly id: string;
  readonly branchId: string;
  readonly terminalType: TerminalType;
  readonly status: TerminalStatus;
}

export interface TerminalFactsQuery {
  /** `null` when the terminal does not exist (or is invisible under RLS). */
  getById(
    tx: Prisma.TransactionClient,
    terminalId: string,
  ): Promise<TerminalFacts | null>;
}
