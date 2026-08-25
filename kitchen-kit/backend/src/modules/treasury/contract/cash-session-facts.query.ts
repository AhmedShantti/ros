import { Prisma } from '../../../generated/prisma/client';

/**
 * Treasury PUBLIC contract — the CashSession facts Payment needs (P1F-1).
 *
 * SRS §5.3 places Payment in Sales, and §5.4 makes `contract/` the ONLY
 * directory another module may import (mechanically enforced by
 * `module-boundaries.spec.ts`). Treasury owns Drawer/CashSession; before
 * this slice it published no query at all (its one route is a write —
 * `cash.session.open`). This is the FIRST `sales -> treasury` edge, mirroring
 * the P1E-6 pattern that gave Sales narrow, read-only public contracts into
 * Catalogue and Organisation for Fire.
 *
 * `find()` is transaction-aware: the CALLER's own `Prisma.TransactionClient`,
 * so a lookup taken mid-capture reads inside the SAME atomic unit of work
 * (SRS §5.5.1) as the Order CAS and the Payment insert — no second
 * transaction, no read-then-write window.
 *
 * The returned facts are ONLY what a Payment capture actually needs to
 * validate P1D-G attribution (tenant/branch/employee/terminal/currency/open
 * status) — nothing else. `CashSession`, `Drawer`, `Shift` and every other
 * Treasury concern stay private; the concrete Prisma-backed implementation
 * lives at `treasury/cash-sessions/cash-session-facts.query.service.ts`, a
 * PRIVATE Treasury path, bound to `CASH_SESSION_FACTS_QUERY` only inside
 * `TreasuryModule`. A consumer (Sales) injects the token and depends on the
 * `CashSessionFactsQuery` interface below; it never imports the concrete
 * implementation.
 *
 * Returns `null` when the id does not resolve (unknown id, or a genuinely
 * cross-tenant id — RLS makes the row invisible to the caller's `tx`
 * regardless of the WHERE clause).
 */
export const CASH_SESSION_FACTS_QUERY = Symbol('CASH_SESSION_FACTS_QUERY');

export interface CashSessionFactsQueryInput {
  readonly tenantId: string;
  readonly cashSessionId: string;
}

export interface CashSessionFacts {
  readonly cashSessionId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly employeeId: string;
  readonly shiftId: string;
  readonly drawerId: string;
  /**
   * The session's drawer's bound terminal, or `null` when the drawer is
   * branch-scoped (usable from any terminal in the branch) — mirroring
   * `Drawer.terminalId`'s own nullability exactly.
   */
  readonly terminalId: string | null;
  readonly currency: string;
  readonly status: 'open' | 'closed';
}

export interface CashSessionFactsQuery {
  find(
    tx: Prisma.TransactionClient,
    input: CashSessionFactsQueryInput,
  ): Promise<CashSessionFacts | null>;
}
