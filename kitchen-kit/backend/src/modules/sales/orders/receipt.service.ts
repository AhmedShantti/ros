import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { toReceiptView } from '../receipt.views';
import { ReceiptNotAvailableError } from './receipt.errors';

/**
 * INTERNAL-MVP RECEIPT — read-only Sales projection. RCPT-R1.
 *
 * Deliberately reads NOTHING outside `sales`-schema tables (`orders`,
 * `order_lines`, `order_line_modifiers`, `order_payments`) — no Catalogue,
 * Localisation, Organisation, Production, Treasury or Identity lookup, so
 * this slice adds zero module-boundary edges and zero `KNOWN_DEVIATIONS`
 * (design gate §N).
 *
 * `AuditService` is deliberately NOT injected: this is a pure GET with no
 * state change, so FR-AUD-001 does not apply (design gate §P.4). If a
 * future change ever needs an audit write on this path, that omission must
 * be revisited explicitly — it is not an oversight.
 */
@Injectable()
export class ReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  async findCompletedOrderReceipt(
    tenantId: string,
    id: string,
    businessDay: Date,
  ) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { id_businessDay: { id, businessDay } },
      });
      // Cross-tenant orders are invisible under RLS -> 404, never 403 (the
      // same convention `OrdersController`'s existing routes follow).
      if (!order) throw new NotFoundException('Order not found.');

      // POS-FIN-1 — a refund (BR-POS-001) moves a completed order to
      // `partially_refunded`/`refunded`; the order's historical receipt
      // must remain retrievable (CR-04: the original posted facts are
      // never rewritten), so all three "was completed" states are
      // accepted here, never only the literal current `completed` value.
      if (
        order.state !== 'completed' &&
        order.state !== 'partially_refunded' &&
        order.state !== 'refunded'
      ) {
        throw new ReceiptNotAvailableError(
          `Order ${id} is '${order.state}'. A receipt can only be produced ` +
            'for an order that has been completed (completed, partially_refunded or refunded).',
        );
      }

      // The exact filter `recomputeOrderTotals` (order-lines.service.ts)
      // uses to compute subtotal/taxTotal/grandTotal, so
      // Σ(lines) ≡ totals holds by construction (design gate §H.6). A
      // voided line was never sent to the kitchen and the customer never
      // received it; `comped` has no writer today but is kept in the
      // filter so a future comp implementation cannot silently break the
      // invariant.
      const lines = await tx.orderLine.findMany({
        where: {
          orderId: order.id,
          businessDay: order.businessDay,
          state: { notIn: ['voided', 'comped'] },
        },
        orderBy: { sequence: 'asc' },
        include: {
          modifiers: { orderBy: { id: 'asc' } },
        },
      });

      const payments = await tx.orderPayment.findMany({
        where: { orderId: order.id, businessDay: order.businessDay },
        orderBy: [{ processedAt: 'asc' }, { id: 'asc' }],
      });

      return toReceiptView(order, lines, payments);
    });
  }
}
