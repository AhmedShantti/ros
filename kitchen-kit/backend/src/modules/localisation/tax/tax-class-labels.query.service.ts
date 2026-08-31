import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  TaxClassLabel,
  TaxClassLabelsQuery,
  TaxClassLabelsQueryInput,
} from '../contract/tax-class-labels.query';

/**
 * PRIVATE Prisma-backed implementation of `TaxClassLabelsQuery`
 * (`localisation/contract/tax-class-labels.query.ts`). Bound to
 * `TAX_CLASS_LABELS_QUERY` only inside `LocalisationModule` — never
 * imported directly by a consumer.
 */
@Injectable()
export class TaxClassLabelsQueryService implements TaxClassLabelsQuery {
  async findByIds(
    tx: Prisma.TransactionClient,
    input: TaxClassLabelsQueryInput,
  ): Promise<ReadonlyMap<string, TaxClassLabel>> {
    if (input.taxClassIds.length === 0) return new Map();
    const rows = await tx.taxClass.findMany({
      where: { tenantId: input.tenantId, id: { in: [...input.taxClassIds] } },
      select: { id: true, code: true, countryPackCode: true },
    });
    const result = new Map<string, TaxClassLabel>();
    for (const row of rows) {
      result.set(row.id, {
        taxClassId: row.id,
        code: row.code,
        countryPackCode: row.countryPackCode,
      });
    }
    return result;
  }
}
