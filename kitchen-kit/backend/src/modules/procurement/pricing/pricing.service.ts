import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  STOCK_ITEM_PURCHASING_FACTS_QUERY,
  type StockItemPurchasingFactsQuery,
} from '../../inventory/contract';
import type { CreateSupplierPriceEntryDto } from '../procurement.dto';
import { isExclusionViolation } from '../procurement-errors';

interface VolumeTierInput {
  readonly minimumQuantity: string;
  readonly unitPriceMinor: string;
}

/**
 * FR-PRC-006 — historical Supplier price entries and comparative pricing
 * (FR-PRC-007). Every write is a NEW immutable row; there is no `update`.
 *
 * `purchaseUnitId` is validated against Inventory's published
 * `STOCK_ITEM_PURCHASING_FACTS_QUERY` contract at write time (§6) — never a
 * private Inventory import.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STOCK_ITEM_PURCHASING_FACTS_QUERY)
    private readonly purchasingFacts: StockItemPurchasingFactsQuery,
  ) {}

  /** §8 — quantities > 0, prices >= 0, strictly increasing, no duplicates. */
  private validateVolumeTiers(tiers?: VolumeTierInput[]): void {
    if (!tiers || tiers.length === 0) return;
    let previous: Prisma.Decimal | null = null;
    for (const tier of tiers) {
      const quantity = new Prisma.Decimal(tier.minimumQuantity);
      const price = BigInt(tier.unitPriceMinor);
      if (quantity.lte(0)) {
        throw new BadRequestException(
          'Volume tier minimumQuantity must be greater than zero.',
        );
      }
      if (price < 0n) {
        throw new BadRequestException(
          'Volume tier unitPriceMinor must not be negative.',
        );
      }
      if (previous !== null && quantity.lte(previous)) {
        throw new BadRequestException(
          'Volume tiers must have strictly increasing, non-duplicate minimumQuantity thresholds.',
        );
      }
      previous = quantity;
    }
  }

  async createPriceEntry(
    tenantId: string,
    actorId: string,
    input: CreateSupplierPriceEntryDto,
  ) {
    this.validateVolumeTiers(input.volumeTiers);

    const validFrom = new Date(input.validFrom);
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if (validUntil && validUntil <= validFrom) {
      throw new BadRequestException('validUntil must be after validFrom.');
    }

    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const link = await tx.supplierItemLink.findUnique({
            where: { id: input.supplierItemLinkId },
            include: { supplier: true },
          });
          if (!link) {
            throw new NotFoundException('Sourcing link not found.');
          }

          // §5 — currency compatibility with the supplier's own configured
          // currency; historical rows are never silently cross-compared.
          if (input.currency !== link.supplier.currency) {
            throw new BadRequestException(
              `Price entry currency (${input.currency}) must match this ` +
                `supplier's configured currency (${link.supplier.currency}).`,
            );
          }

          // §6 — purchase unit must be valid for the sourced stock item.
          const facts = await this.purchasingFacts.find(tx, {
            tenantId,
            stockItemId: link.stockItemId,
          });
          if (!facts) {
            throw new NotFoundException('Stock item not found.');
          }
          const unit = facts.purchaseUnits.find(
            (u) => u.id === input.purchaseUnitId,
          );
          if (!unit) {
            throw new BadRequestException(
              'purchaseUnitId is not a valid purchase unit for this stock item.',
            );
          }

          const entry = await tx.supplierPriceEntry.create({
            data: {
              id: newId(),
              tenantId,
              supplierId: link.supplierId,
              supplierItemLinkId: link.id,
              purchaseUnitId: input.purchaseUnitId,
              packSize: new Prisma.Decimal(input.packSize),
              unitPrice: BigInt(input.unitPrice),
              currency: input.currency,
              validFrom,
              validUntil,
              volumeTiers: input.volumeTiers
                ? (input.volumeTiers as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SUPPLIER_PRICE_ENTRY_CREATED,
            entityType: AUDIT_ENTITY.SUPPLIER_PRICE_ENTRY,
            actorType: 'user',
            actorId,
            entityId: entry.id,
            metadata: {
              supplierItemLinkId: link.id,
              purchaseUnitId: input.purchaseUnitId,
              currency: entry.currency,
              validFrom: entry.validFrom.toISOString(),
            },
          });

          return entry;
        },
      );
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new ConflictException(
          'FR-PRC-006 §7: another price entry already covers this supplier ' +
            'item link and purchase unit for an overlapping validity window.',
        );
      }
      throw err;
    }
  }

  async history(tenantId: string, actorId: string, supplierItemLinkId: string) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplierPriceEntry.findMany({
        where: { supplierItemLinkId },
        orderBy: { validFrom: 'desc' },
      }),
    );
  }

  /** §7 deterministic effective-price resolution: validFrom <= at AND
   *  (validUntil IS NULL OR at < validUntil). The exclusion constraint
   *  guarantees at most one row matches per purchase unit. */
  async effectivePrice(
    tenantId: string,
    actorId: string,
    supplierItemLinkId: string,
    at: Date,
    purchaseUnitId?: string,
  ) {
    return this.prisma.withAuthContext({ userId: actorId, tenantId }, (tx) =>
      tx.supplierPriceEntry.findMany({
        where: {
          supplierItemLinkId,
          purchaseUnitId,
          validFrom: { lte: at },
          OR: [{ validUntil: null }, { validUntil: { gt: at } }],
        },
      }),
    );
  }

  /** §9 — comparative supplier pricing for a stock item at instant `at`. */
  async comparativePricing(
    tenantId: string,
    actorId: string,
    stockItemId: string,
    at: Date,
    quantity?: string,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const links = await tx.supplierItemLink.findMany({
          where: {
            stockItemId,
            isActive: true,
            supplier: { status: 'active' },
          },
          include: { supplier: true },
          orderBy: [{ preferenceRank: 'asc' }],
        });

        const quantityDecimal = quantity ? new Prisma.Decimal(quantity) : null;
        const results: Array<{
          supplierId: string;
          supplierCode: string;
          supplierName: string;
          supplierStatus: string;
          supplierItemLinkId: string;
          preferenceRank: number;
          supplierItemCode: string | null;
          purchaseUnitId: string;
          packSize: string;
          currency: string;
          unitPrice: string;
          selectedTier: {
            minimumQuantity: string;
            unitPriceMinor: string;
          } | null;
          validFrom: string;
          validUntil: string | null;
          volumeTiers: unknown;
        }> = [];

        for (const link of links) {
          const entries = await tx.supplierPriceEntry.findMany({
            where: {
              supplierItemLinkId: link.id,
              validFrom: { lte: at },
              OR: [{ validUntil: null }, { validUntil: { gt: at } }],
            },
          });

          for (const entry of entries) {
            const tiers = (entry.volumeTiers ?? null) as
              VolumeTierInput[] | null;
            let selectedTier: VolumeTierInput | null = null;
            if (tiers && quantityDecimal) {
              for (const tier of tiers) {
                if (
                  new Prisma.Decimal(tier.minimumQuantity).lte(quantityDecimal)
                ) {
                  selectedTier = tier;
                } else {
                  break;
                }
              }
            }

            results.push({
              supplierId: link.supplier.id,
              supplierCode: link.supplier.code,
              supplierName: link.supplier.legalName,
              supplierStatus: link.supplier.status,
              supplierItemLinkId: link.id,
              preferenceRank: link.preferenceRank,
              supplierItemCode: link.supplierItemCode,
              purchaseUnitId: entry.purchaseUnitId,
              packSize: entry.packSize.toString(),
              currency: entry.currency,
              unitPrice: entry.unitPrice.toString(),
              selectedTier,
              validFrom: entry.validFrom.toISOString(),
              validUntil: entry.validUntil
                ? entry.validUntil.toISOString()
                : null,
              volumeTiers: entry.volumeTiers,
            });
          }
        }

        // Deterministic ordering (§9): preferenceRank first, then a stable
        // secondary key (supplier code) so equal-preference results never
        // depend on incidental row order.
        results.sort(
          (a, b) =>
            a.preferenceRank - b.preferenceRank ||
            a.supplierCode.localeCompare(b.supplierCode) ||
            a.purchaseUnitId.localeCompare(b.purchaseUnitId),
        );

        return results;
      },
    );
  }
}
