import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { CountScope, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { MovementsService } from '../movements/movements.service';

export interface OpenCountInput {
  locationId: string;
  scopeType: CountScope;
  /** Category id when scopeType = category. */
  scopeId?: string;
  /** Stock item ids when scopeType = item_list (D-INV-05 ad-hoc list). */
  itemIds?: string[];
  isBlindCount?: boolean;
  /** B-2: caller-supplied approval gate. Inventory NEVER evaluates a threshold. */
  requiresApproval?: boolean;
}

/**
 * Stock counting (FR-INV-040…051).
 *
 * D-INV-05 scope: full location, category, or an ad-hoc item list held in
 * `count_session_items`. No storage-area entity exists.
 *
 * FR-INV-044: `expectedQuantity` is FROZEN per line when the session opens, so
 * trading during the count window cannot corrupt the variance. Movements
 * occurring after `startedAt` are reported at posting rather than silently
 * folded into the variance.
 *
 * B-2 approval gate: `requiresApproval` is supplied by the caller. When true,
 * posting is REFUSED, because no approved Governance request can exist — the
 * Governance context is not implemented. Inventory owns the gate only.
 */
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  async open(tenantId: string, actorId: string, input: OpenCountInput) {
    if (input.scopeType === 'category' && !input.scopeId) {
      throw new BadRequestException(
        'scopeId is required for a category scope.',
      );
    }
    if (input.scopeType !== 'category' && input.scopeId) {
      throw new BadRequestException(
        'scopeId is only valid for a category scope.',
      );
    }
    if (input.scopeType === 'item_list' && !input.itemIds?.length) {
      throw new BadRequestException(
        'itemIds is required for an item_list scope.',
      );
    }

    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const session = await tx.countSession.create({
            data: {
              id: newId(),
              tenantId,
              locationId: input.locationId,
              scopeType: input.scopeType,
              scopeId: input.scopeId ?? null,
              isBlindCount: input.isBlindCount ?? true,
              startedBy: actorId,
              requiresApproval: input.requiresApproval ?? false,
            },
          });

          // Resolve the item set for the scope.
          const items = await this.resolveScopeItems(tx, input, session.id);

          // FR-INV-044: freeze expected quantities at open.
          const levels = await tx.stockLevel.findMany({
            where: {
              locationId: input.locationId,
              stockItemId: { in: items },
            },
          });
          const byItem = new Map(levels.map((l) => [l.stockItemId, l]));
          for (const stockItemId of items) {
            await tx.countLine.create({
              data: {
                id: newId(),
                countSessionId: session.id,
                stockItemId,
                expectedQuantity: byItem.get(stockItemId)?.quantityOnHand ?? 0,
              },
            });
          }

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.COUNT_SESSION_OPENED,
            entityType: AUDIT_ENTITY.COUNT_SESSION,
            actorType: 'user',
            actorId,
            entityId: session.id,
            metadata: {
              locationId: input.locationId,
              scopeType: input.scopeType,
              isBlindCount: session.isBlindCount,
              lineCount: items.length,
            },
          });
          return {
            id: session.id,
            scopeType: session.scopeType,
            isBlindCount: session.isBlindCount,
            status: session.status,
            lineCount: items.length,
          };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(err, 'Location, category or item not found.');
    }
  }

  private async resolveScopeItems(
    tx: Parameters<MovementsService['post']>[0],
    input: OpenCountInput,
    sessionId: string,
  ): Promise<string[]> {
    if (input.scopeType === 'item_list') {
      const ids = input.itemIds ?? [];
      for (const stockItemId of ids) {
        await tx.countSessionItem.create({
          data: { id: newId(), countSessionId: sessionId, stockItemId },
        });
      }
      return ids;
    }
    const where =
      input.scopeType === 'category'
        ? { categoryId: input.scopeId, isActive: true }
        : { isActive: true };
    const rows = await tx.stockItem.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Blind count hides the expected quantity while the session is open. */
  async lines(tenantId: string, sessionId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const session = await tx.countSession.findUnique({
        where: { id: sessionId },
      });
      if (!session) throw new NotFoundException('Count session not found.');
      const lines = await tx.countLine.findMany({
        where: { countSessionId: sessionId },
      });
      const hide = session.isBlindCount && session.status === 'in_progress';
      return lines.map((l) => ({
        id: l.id,
        stockItemId: l.stockItemId,
        expectedQuantity: hide
          ? null
          : (l.expectedQuantity?.toString() ?? null),
        countedQuantity: l.countedQuantity?.toString() ?? null,
        variance: l.variance?.toString() ?? null,
      }));
    });
  }

  async recordCount(
    tenantId: string,
    actorId: string,
    lineId: string,
    /** Exact decimal string (BR-CORE-003) — see `RecordCountDto.countedQuantity`. */
    countedQuantity: string,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const line = await tx.countLine.findUnique({ where: { id: lineId } });
        if (!line) throw new NotFoundException('Count line not found.');
        const session = await tx.countSession.findUnique({
          where: { id: line.countSessionId },
        });
        if (session?.status !== 'in_progress') {
          throw new BadRequestException('Count session is not in progress.');
        }
        // Exact from the authoritative input onward: `countedQuantity` is a
        // validated decimal string and `line.expectedQuantity` is already a
        // Prisma.Decimal (exact) — no Number()/JS subtraction determines the
        // persisted `variance`, the value that later becomes a
        // `count_adjustment` movement's `stock_movements.quantity` (§post).
        const countedExact = new Prisma.Decimal(countedQuantity);
        const expectedExact = line.expectedQuantity ?? new Prisma.Decimal(0);
        const varianceExact = countedExact.minus(expectedExact);
        const updated = await tx.countLine.update({
          where: { id: lineId },
          data: {
            countedQuantity: countedExact,
            variance: varianceExact,
          },
        });
        return {
          id: updated.id,
          countedQuantity: updated.countedQuantity?.toString() ?? null,
          variance: updated.variance?.toString() ?? null,
        };
      },
    );
  }

  /**
   * FR-INV-045: posting creates `count_adjustment` movements bringing recorded
   * stock to counted stock. Post-once is guarded by the session status.
   *
   * B-2: if `requiresApproval` is set, posting is REFUSED — there is no
   * Governance approval to satisfy it. FR-INV-046/047's threshold-driven
   * variants remain BLOCKED by that missing context.
   */
  async post(tenantId: string, actorId: string, sessionId: string) {
    return this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const session = await tx.countSession.findUnique({
          where: { id: sessionId },
        });
        if (!session) throw new NotFoundException('Count session not found.');
        if (session.status !== 'in_progress') {
          throw new BadRequestException(
            'Count session has already been posted.',
          );
        }
        if (session.requiresApproval) {
          throw new ForbiddenException(
            'This count requires approval before posting. The Governance ' +
              'approval workflow is not implemented in this phase, so the ' +
              'posting is refused rather than completed unapproved.',
          );
        }

        // A1-4 (deadlock matrix, §11): deterministic stockItemId ASC order —
        // the SAME global lock order Completion (`SaleDepletionService`) and
        // `WasteService` use — so a multi-item count posting can never
        // invert against a concurrent multi-item writer touching the same
        // two items and deadlock.
        const lines = await tx.countLine.findMany({
          where: { countSessionId: sessionId, countedQuantity: { not: null } },
          orderBy: { stockItemId: 'asc' },
        });

        // FR-INV-044 / CT-08: `line.variance` (written in `recordCount`) is
        // counted vs the quantity FROZEN at session open — it does not yet
        // know about movements that happened DURING the count window, so
        // using it as-is would report a concurrent sale as false shrinkage.
        // The genuine variance the posted movement must carry is:
        //   expected_at_post = expected_at_open + movements_during_window
        //   true_variance     = counted_quantity - expected_at_post
        //                      = line.variance   - movements_during_window
        // "movements during the window" = every `stock_movements` row for
        // this (item, location) with `occurred_at` after `session.startedAt`
        // (the immutable open-time cutoff) and committed by the time THIS
        // query runs — exactly the boundary FR-INV-044 already uses below
        // for the audit-only count, now also driving the posted amount.
        // `Prisma.groupBy._sum` is exact (Prisma.Decimal / decimal.js), so
        // no Number()/parseFloat() touches a value that determines the
        // persisted `count_adjustment` quantity.
        const windowSums = await tx.stockMovement.groupBy({
          by: ['stockItemId'],
          where: {
            locationId: session.locationId,
            stockItemId: { in: lines.map((l) => l.stockItemId) },
            occurredAt: { gt: session.startedAt },
          },
          _sum: { quantity: true },
        });
        const windowByItem = new Map(
          windowSums.map((w) => [
            w.stockItemId,
            w._sum.quantity ?? new Prisma.Decimal(0),
          ]),
        );

        // FR-INV-044: movements during the count window are reported, not folded
        // into the variance — the expected quantity was frozen at open.
        const duringWindow = await tx.stockMovement.count({
          where: {
            locationId: session.locationId,
            occurredAt: { gt: session.startedAt },
          },
        });

        const adjustments: { stockItemId: string; variance: number }[] = [];
        for (const line of lines) {
          // Exact: `line.variance` is already a Prisma.Decimal (written
          // exactly in `recordCount` above) — no Number()/parseFloat() on the
          // value that determines this movement's persisted quantity.
          const rawVariance = line.variance ?? new Prisma.Decimal(0);
          const movementsDuringWindow =
            windowByItem.get(line.stockItemId) ?? new Prisma.Decimal(0);
          const trueVariance = rawVariance.minus(movementsDuringWindow);
          // Persist the CORRECTED (window-adjusted) variance onto the line
          // itself, even when it nets to zero — otherwise the line would go
          // on displaying the raw counted-vs-opening-baseline figure via
          // `lines()`, silently disagreeing with what was actually posted
          // (or not posted) to the ledger. Not a ledger row — updating it is
          // not an append-only/BR-INV-001 concern.
          await tx.countLine.update({
            where: { id: line.id },
            data: { variance: trueVariance },
          });
          if (trueVariance.isZero()) continue;
          await this.movements.post(tx, tenantId, actorId, {
            locationId: session.locationId,
            stockItemId: line.stockItemId,
            movementType: 'count_adjustment',
            quantity: trueVariance.toFixed(6),
            referenceType: 'count',
            referenceId: sessionId,
          });
          // Transport-boundary conversion only (postCountResultSchema
          // documents `variance` as a JS number) — the movement above is
          // already posted from the exact value, and this reports the
          // GENUINE (window-adjusted) variance actually posted, not the raw
          // counted-vs-opening-baseline figure still held on the line.
          adjustments.push({
            stockItemId: line.stockItemId,
            variance: trueVariance.toNumber(),
          });
        }

        await tx.countSession.update({
          where: { id: sessionId },
          data: { status: 'posted', postedAt: new Date(), postedBy: actorId },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.COUNT_SESSION_POSTED,
          entityType: AUDIT_ENTITY.COUNT_SESSION,
          actorType: 'user',
          actorId,
          entityId: sessionId,
          metadata: {
            adjustmentCount: adjustments.length,
            movementsDuringCountWindow: duringWindow,
          },
        });
        return {
          id: sessionId,
          status: 'posted',
          adjustments,
          movementsDuringCountWindow: duringWindow,
        };
      },
    );
  }
}
