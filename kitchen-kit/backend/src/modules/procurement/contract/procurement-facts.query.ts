import { Prisma } from '../../../generated/prisma/client';

/**
 * Procurement PUBLIC contract — the narrow read surface the FUTURE Purchase
 * Order slice needs (mission brief §15), so it never imports a private
 * Supplier/Sourcing/Pricing service or queries `procurement.*` tables
 * directly (`module-boundaries.spec.ts`).
 *
 * Deliberately NOT the whole PO domain: no requisition/approval/receiving
 * vocabulary, no "is this supplier approved for this order" business rule —
 * only the facts a PO snapshot needs, exactly as named in §15:
 *   - require an active supplier for the tenant
 *   - get supplier facts needed for a PO snapshot
 *   - validate a supplier actually supplies an item
 *   - resolve the supplier/item effective price at an instant
 *   - obtain the current preference/sourcing facts
 *
 * `tx`-FIRST — composed inside the caller's own transaction (SRS §5.5.1).
 */
export const PROCUREMENT_FACTS_QUERY = Symbol('PROCUREMENT_FACTS_QUERY');

export interface SupplierFacts {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly status: 'active' | 'inactive';
  readonly currency: string;
  readonly paymentTermsNetDays: number;
}

export interface SupplierItemSourcingFacts {
  readonly supplierItemLinkId: string;
  readonly supplierId: string;
  readonly stockItemId: string;
  readonly supplierItemCode: string | null;
  readonly supplierBarcodes: readonly string[];
  readonly preferenceRank: number;
  readonly isActive: boolean;
}

export interface VolumeTierFacts {
  readonly minimumQuantity: string;
  readonly unitPriceMinor: string;
}

export interface EffectiveSupplierPriceFacts {
  readonly priceEntryId: string;
  readonly purchaseUnitId: string;
  /** Decimal string, 6dp. */
  readonly packSize: string;
  /** Minor-unit money string. */
  readonly unitPrice: string;
  readonly currency: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly volumeTiers: readonly VolumeTierFacts[] | null;
}

export interface ProcurementFactsQuery {
  /** `null` when the supplier is not visible in this tenant. Callers that
   *  need it ACTIVE check `status` themselves — this contract states facts,
   *  it does not invent a PO-specific rejection rule. */
  getSupplierFacts(
    tx: Prisma.TransactionClient,
    input: { readonly tenantId: string; readonly supplierId: string },
  ): Promise<SupplierFacts | null>;

  /** `null` when no sourcing link exists for this (supplier, stock item). */
  getSupplierItemSourcing(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly supplierId: string;
      readonly stockItemId: string;
    },
  ): Promise<SupplierItemSourcingFacts | null>;

  /** `null` when no agreed price is effective for this scope at `at`. */
  getEffectivePrice(
    tx: Prisma.TransactionClient,
    input: {
      readonly tenantId: string;
      readonly supplierItemLinkId: string;
      readonly purchaseUnitId: string;
      readonly at: Date;
    },
  ): Promise<EffectiveSupplierPriceFacts | null>;
}
