import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  CashSessionFacts,
  CashSessionFactsQuery,
  CashSessionFactsQueryInput,
} from '../contract';

/**
 * PRIVATE Prisma-backed implementation of `CashSessionFactsQuery` (P1F-1).
 *
 * Never imported directly by another module — only through the
 * `CASH_SESSION_FACTS_QUERY` token `TreasuryModule` binds it to
 * (`module-boundaries.spec.ts` proves this mechanically, mirroring the
 * Catalogue Fire-facts / Organisation table-display precedent from P1E-6).
 */
@Injectable()
export class CashSessionFactsQueryService implements CashSessionFactsQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: CashSessionFactsQueryInput,
  ): Promise<CashSessionFacts | null> {
    const session = await tx.cashSession.findUnique({
      where: { id: input.cashSessionId },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        employeeId: true,
        shiftId: true,
        drawerId: true,
        currency: true,
        status: true,
        drawer: { select: { terminalId: true } },
      },
    });
    if (!session) return null;

    return {
      cashSessionId: session.id,
      tenantId: session.tenantId,
      branchId: session.branchId,
      employeeId: session.employeeId,
      shiftId: session.shiftId,
      drawerId: session.drawerId,
      terminalId: session.drawer.terminalId,
      currency: session.currency,
      status: session.status,
    };
  }
}
