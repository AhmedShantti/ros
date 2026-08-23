import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PriceCandidate,
  PriceResolution,
  resolvePrice,
} from './price-resolution';

export interface ResolvePriceQuery {
  readonly branchId: string;
  readonly menuItemVariantId: string;
  /** Order type being priced (FR-MNU-021); null means "no order type applies". */
  readonly orderType?: string | null;
  /**
   * Instant to evaluate at. Supplied by the caller so the result is reproducible
   * and testable; defaults to now for ordinary call sites.
   */
  readonly at?: Date;
}

/**
 * Evaluates the stored `catalogue.price_lists` / `price_entries` records rather
 * than merely returning them (FR-MNU-020…023).
 *
 * This is a query service with no HTTP surface. The SRS does not define a
 * catalogue endpoint that returns a resolved price — FR-POS-040 places
 * resolution at order time, in a Sales layer that does not exist yet — so no
 * route is invented here. Sales will consume this directly when it is built.
 *
 * All reads go through `withAuthContext`, so RLS applies exactly as it does
 * everywhere else: a branch or variant belonging to another tenant is invisible
 * and surfaces as 404, never as a cross-tenant read.
 */
@Injectable()
export class PriceResolutionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve on the caller's OWN transaction.
   *
   * Sales line capture must price inside the same transaction that writes the
   * line, and `withAuthContext` cannot nest (Prisma has no nested interactive
   * transactions). Splitting the body out is what lets Sales reuse THIS
   * resolver rather than growing a second copy of the FR-POS-040 tier rules —
   * a duplicate pricing path is exactly the defect this avoids.
   */
  async resolveIn(
    tx: Prisma.TransactionClient,
    query: ResolvePriceQuery,
  ): Promise<PriceResolution> {
    const at = query.at ?? new Date();
    {
      // The branch supplies the brand and the IANA timezone (FR-MNU-022).
      // Invisible under RLS when it belongs to another tenant → 404.
      const branch = await tx.branch.findUnique({
        where: { id: query.branchId },
        select: { id: true, brandId: true, timezone: true },
      });
      if (!branch) {
        throw new NotFoundException('Branch not found.');
      }

      const variant = await tx.menuItemVariant.findUnique({
        where: { id: query.menuItemVariantId },
        select: { id: true },
      });
      if (!variant) {
        throw new NotFoundException('Menu item variant not found.');
      }

      const entries = await tx.priceEntry.findMany({
        where: { menuItemVariantId: query.menuItemVariantId },
        select: {
          id: true,
          price: true,
          currency: true,
          priceList: {
            select: {
              id: true,
              name: true,
              scopeType: true,
              scopeId: true,
              orderType: true,
              validFrom: true,
              validTo: true,
              recurrenceRule: true,
              priority: true,
              status: true,
            },
          },
        },
      });

      const candidates: PriceCandidate[] = entries.map((e) => ({
        priceListId: e.priceList.id,
        priceListName: e.priceList.name,
        scopeType: e.priceList.scopeType,
        scopeId: e.priceList.scopeId,
        orderType: e.priceList.orderType,
        validFrom: e.priceList.validFrom,
        validTo: e.priceList.validTo,
        recurrenceRule: e.priceList.recurrenceRule ?? null,
        priority: e.priceList.priority,
        status: e.priceList.status,
        entryId: e.id,
        priceMinorUnits: e.price,
        currency: e.currency,
      }));

      return resolvePrice(candidates, {
        brandId: branch.brandId,
        branchId: branch.id,
        branchTimezone: branch.timezone,
        menuItemVariantId: query.menuItemVariantId,
        orderType: query.orderType ?? null,
        at,
      });
    }
  }

  /** Resolve in its own RLS-scoped transaction, for callers with none. */
  async resolve(
    tenantId: string,
    query: ResolvePriceQuery,
  ): Promise<PriceResolution> {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.resolveIn(tx, query),
    );
  }
}
