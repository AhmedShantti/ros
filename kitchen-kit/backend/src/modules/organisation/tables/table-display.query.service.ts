import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  TableDisplayQuery,
  TableDisplayQueryInput,
  TableDisplayResult,
} from '../contract/table-display.query';

/**
 * PRIVATE Prisma-backed implementation of `TableDisplayQuery`
 * (`organisation/contract/table-display.query.ts`). Bound to
 * `TABLE_DISPLAY_QUERY` only inside `OrganisationModule` (`useExisting`) —
 * never imported directly by a consumer; see `module-boundaries.spec.ts`'s
 * contract-purity assertions.
 *
 * `tenantId` is not filterable directly on `org.tables` (it has no
 * `tenant_id` column of its own — tenancy is enforced by RLS through the
 * owning branch, the same shape `TablesService` already reads under). The
 * caller's `Prisma.TransactionClient` is already inside a tenant-scoped
 * `withAuthContext`/`UnitOfWork.execute` RLS session, so `tenantId` is
 * accepted here for interface symmetry with the other Fire-facts contracts
 * and as a readable statement of intent, not as an additional WHERE clause
 * RLS already makes redundant.
 */
@Injectable()
export class TableDisplayQueryService implements TableDisplayQuery {
  async find(
    tx: Prisma.TransactionClient,
    input: TableDisplayQueryInput,
  ): Promise<TableDisplayResult | null> {
    const table = await tx.branchTable.findUnique({
      where: { id: input.tableId },
      select: { label: true },
    });
    return table ? { label: table.label } : null;
  }
}
