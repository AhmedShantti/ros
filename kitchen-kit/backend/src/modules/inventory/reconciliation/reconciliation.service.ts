import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * On-demand computations for the requirements whose TRIGGER infrastructure is
 * deferred (D-INV-08).
 *
 * The project has no scheduler, job runner, outbox or notification channel, and
 * D-INV-08 forbids inventing one. So the LOGIC lives here and is callable and
 * testable; only the scheduling and delivery are deferred. None of these
 * requirements is claimed as fully satisfied:
 *
 *   FR-INV-011 / FR-INV-051  ledger-vs-projection reconciliation  (logic here)
 *   FR-INV-014               negative-stock detection             (logic here)
 *   FR-INV-024               expiry horizons                      (logic here)
 *   FR-INV-066               low-stock vs per-location reorder    (logic here)
 *   FR-DR-002                partition pre-creation               (not here)
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * BR-INV-003 — the sum of movements for an (item, location) pair MUST equal
   * the `stock_levels` projection. Returns every divergence; an empty list is
   * the healthy state.
   */
  reconcile(tenantId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        {
          stock_item_id: string;
          location_id: string;
          projected: string;
          ledger: string;
        }[]
      >(
        `SELECT l.stock_item_id, l.location_id,
                l.quantity_on_hand::text AS projected,
                COALESCE(SUM(m.quantity), 0)::text AS ledger
           FROM inventory.stock_levels l
           LEFT JOIN inventory.stock_movements m
             ON m.stock_item_id = l.stock_item_id
            AND m.location_id  = l.location_id
          GROUP BY l.stock_item_id, l.location_id, l.quantity_on_hand
         HAVING l.quantity_on_hand <> COALESCE(SUM(m.quantity), 0)`,
      );
      return {
        divergences: rows.map((r) => ({
          stockItemId: r.stock_item_id,
          locationId: r.location_id,
          projected: r.projected,
          ledger: r.ledger,
        })),
        reconciled: rows.length === 0,
        note: 'Scheduling and alert delivery are deferred (D-INV-08); this is the on-demand computation.',
      };
    });
  }

  /** FR-INV-014 — negative levels are permitted and recorded; this surfaces them. */
  negativeStock(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.stockLevel.findMany({ where: { quantityOnHand: { lt: 0 } } }),
      )
      .then((rows) =>
        rows.map((r) => ({
          stockItemId: r.stockItemId,
          locationId: r.locationId,
          quantityOnHand: r.quantityOnHand.toString(),
        })),
      );
  }

  /** FR-INV-024 — batches expiring within `days` (default 7). */
  expiring(tenantId: string, days = 7) {
    const horizon = new Date();
    horizon.setUTCDate(horizon.getUTCDate() + days);
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.stockBatch.findMany({
          where: {
            quantityRemaining: { gt: 0 },
            expiryDate: { not: null, lte: horizon },
          },
          orderBy: { expiryDate: 'asc' },
        }),
      )
      .then((rows) =>
        rows.map((b) => ({
          batchId: b.id,
          stockItemId: b.stockItemId,
          locationId: b.locationId,
          expiryDate: b.expiryDate,
          quantityRemaining: b.quantityRemaining.toString(),
        })),
      );
  }

  /** FR-INV-066 — levels below their PER-LOCATION reorder point (FR-INV-065). */
  lowStock(tenantId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const configs = await tx.stockItemReorderConfig.findMany();
      const levels = await tx.stockLevel.findMany();
      const key = (s: string, l: string) => `${s}:${l}`;
      const byKey = new Map(
        levels.map((l) => [key(l.stockItemId, l.locationId), l]),
      );
      return configs
        .filter((c) => {
          if (c.reorderPoint === null) return false;
          const level = byKey.get(key(c.stockItemId, c.locationId));
          const onHand = level ? Number(level.quantityOnHand) : 0;
          return onHand < Number(c.reorderPoint);
        })
        .map((c) => ({
          stockItemId: c.stockItemId,
          locationId: c.locationId,
          reorderPoint: c.reorderPoint?.toString() ?? null,
          reorderQuantity: c.reorderQuantity?.toString() ?? null,
          quantityOnHand:
            byKey
              .get(key(c.stockItemId, c.locationId))
              ?.quantityOnHand.toString() ?? '0',
        }));
    });
  }

  /** FR-INV-010/015 — current levels for a location. */
  levels(tenantId: string, locationId?: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.stockLevel.findMany({
          ...(locationId ? { where: { locationId } } : {}),
        }),
      )
      .then((rows) =>
        rows.map((r) => ({
          stockItemId: r.stockItemId,
          locationId: r.locationId,
          quantityOnHand: r.quantityOnHand.toString(),
          quantityReserved: r.quantityReserved.toString(),
          lastReconciledAt: r.lastReconciledAt,
        })),
      );
  }
}
