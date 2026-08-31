import { Prisma } from '../../../generated/prisma/client';

/**
 * Localisation PUBLIC contract — manager-readable taxClass labels only, for
 * the Minimum Operational Reporting slice's tax breakdown by taxClass
 * (RPT-R1/R2/R3; design gate + acceptance correction §22).
 *
 * Deliberately excludes rates, tax components and any tax-engine
 * configuration — Reporting never touches Localisation's tax-domain
 * internals, only the two fields a manager needs to read a `taxClassId` on
 * a report row: `code` (the immutable semantic key) and `countryPackCode`
 * (which jurisdiction it belongs to). `names` (the localised display label
 * Json) is intentionally NOT exposed here — `code` is what the design gate
 * calls the manager-readable label; adding a locale-resolution concern to
 * this contract would be new scope this slice does not authorise.
 *
 * An id that does not resolve (unknown, or a genuinely cross-tenant id —
 * RLS) is simply ABSENT from the returned map, never an error: an
 * unresolved label must not fail the whole financial report (design gate
 * §22 — "Do not fail the whole financial report merely because a
 * manager-readable label cannot be resolved").
 */
export const TAX_CLASS_LABELS_QUERY = Symbol('TAX_CLASS_LABELS_QUERY');

export interface TaxClassLabelsQueryInput {
  readonly tenantId: string;
  readonly taxClassIds: readonly string[];
}

export interface TaxClassLabel {
  readonly taxClassId: string;
  readonly code: string;
  readonly countryPackCode: string;
}

export interface TaxClassLabelsQuery {
  findByIds(
    tx: Prisma.TransactionClient,
    input: TaxClassLabelsQueryInput,
  ): Promise<ReadonlyMap<string, TaxClassLabel>>;
}
