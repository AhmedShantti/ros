import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  TerminalFacts,
  TerminalFactsQuery,
} from '../contract/terminal-facts.query';

/**
 * PRIVATE Identity implementation of the `TerminalFactsQuery` contract.
 * Bound to the `TERMINAL_FACTS_QUERY` token inside `IdentityModule` only —
 * never exported by class, only by the token (mirrors
 * `RoutingConfigQueryService` / `TerminalPinVerifier`'s own split between a
 * public interface and a private Prisma-backed implementation).
 */
@Injectable()
export class TerminalFactsQueryService implements TerminalFactsQuery {
  async getById(
    tx: Prisma.TransactionClient,
    terminalId: string,
  ): Promise<TerminalFacts | null> {
    return tx.terminal.findUnique({
      where: { id: terminalId },
      select: {
        id: true,
        branchId: true,
        terminalType: true,
        status: true,
      },
    });
  }
}
