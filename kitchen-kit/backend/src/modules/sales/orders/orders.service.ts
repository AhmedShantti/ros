import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UUID_PATTERN, newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
import { BRANCH_BRAND_QUERY } from '../../organisation/contract';
import type { BranchBrandQuery } from '../../organisation/contract';
import { DAY_CLOSE_STATE_QUERY } from '../../treasury/contract';
import type { DayCloseStateQuery } from '../../treasury/contract';
import { cutoverLookup, resolveBusinessDay } from './business-day';
import { ServiceChargePolicyResolver } from '../service-charge-policy/service-charge-policy.resolver';
import {
  DEFAULT_BLOCK_SIZE,
  formatOrderNumber,
  makeBlock,
  nextBlockStart,
  takeNext,
} from './order-number';
import { OrderState, assertOrderMutable, assertVersion } from './order-state';

export interface CreateOrderInput {
  /** FR-OFF-015 - the device's ULID. Persisted exactly; never reassigned. */
  readonly id?: string;
  /**
   * The POS session's operating branch — CROSSCUT-POS-KDS-TERMINAL-
   * DECOUPLING-P0. POS is a branch/employee-scoped application session, not
   * a registered device identity, so the branch is trusted from the
   * caller's own live-verified `TenantContext.branchId` (never a request
   * body), exactly as it was previously trusted from a terminal's
   * registration.
   */
  readonly branchId: string;
  readonly openedByEmployeeId: string;
  readonly orderType: string;
  readonly channel: string;
  readonly tableId?: string | null;
  readonly guestCount?: number | null;
  readonly originDeviceTime: Date;
  readonly idempotencyKey: string;
  readonly notes?: string | null;
  /**
   * The instant the server attributes the sale to. Defaults to now.
   *
   * It drives BOTH the business day (FR-FIN-024) and the country pack version in
   * force (FR-LOC-021), so it is a server decision, never a client one. The
   * device's own clock is preserved separately as `origin_device_time`.
   */
  readonly at?: Date;
}

/**
 * Order capture.
 *
 * ── WHAT IS NOW SERVER-DERIVED ──────────────────────────────────────────────
 * Nothing financially significant is taken from the caller. The branch comes
 * from the terminal's registration, the business day from the branch's timezone
 * and FR-FIN-024 cutover, the currency from the branch, the order number from
 * the terminal's held block, and `country_pack_version` from the pack in force
 * for the branch's jurisdiction at the transaction instant (FR-LOC-021). The
 * client supplies its own ULID, its own clock reading and an idempotency key —
 * an identity and two facts about the device, none of which is money.
 *
 * ── WHY THERE IS STILL NO `addLine` ─────────────────────────────────────────
 * `order_lines` carries two mandatory BR-POS-004 snapshots that nothing in this
 * repository can truthfully produce:
 *
 *   · `tax_class_id UUID NOT NULL` — the country pack identifies a tax class by
 *     semantic CODE (`standard`, `zero`, …). The approved SQL's
 *     `fiscal.tax_classes` would supply a UUID but has no column binding a row
 *     to a pack class code, and `catalogue.menu_items.tax_class_id` is nullable
 *     and FK-less by ratified C-04. Any UUID written here would be invented.
 *   · `unit_cost_snapshot` — FR-CST-001/002 define it as the recipe's cost, and
 *     D-17-05 defers costing entirely: `recipe_versions.computed_cost` is
 *     provably never written. BR-MNU-012 authorises zero cost ONLY for an
 *     actually incomplete or absent recipe, not for a complete one whose cost
 *     merely has not been computed.
 *
 * The tax ENGINE exists and is exercised by the conformance corpus; it is the
 * physical tax-class identity and the cost source that are missing. Exposing a
 * line writer would mean fabricating both.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly countryPacks: CountryPackService,
    /**
     * Migration 35 (DayClose) — the shared Order-create/DayClose cutover
     * fence's Order-create side (pre-ratification final correction §4.4,
     * "Option B"). Consumed inside THIS transaction, immediately after
     * `allocateOrderNumber` acquires the existing
     * `ros_order_number(branchId, businessDay)` advisory lock and BEFORE the
     * `Order` `INSERT` — never a second lock namespace, never a private
     * Treasury table query.
     */
    @Inject(DAY_CLOSE_STATE_QUERY)
    private readonly dayCloseState: DayCloseStateQuery,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
    /**
     * P2D (ratified P2D-R1 clause 7) — resolved and pinned at the SAME
     * instant (`at`) and in the SAME transaction as `countryPackVersion`
     * below. Additive: an order pins `null` when no ServiceChargePolicy
     * version is configured anywhere in scope — never a fabricated
     * default, never a reason order creation itself can fail.
     */
    private readonly serviceChargePolicies: ServiceChargePolicyResolver,
  ) {}

  /**
   * Reserve the next order number for a branch on a business day.
   *
   * FR-POS-002 / FR-OFF-016: numbers come from a block held for the BRANCH.
   * A row lock on the block row serialises concurrent allocation, so two
   * concurrent requests at one branch can never receive the same sequence.
   * `MAX(order_number) + 1` is never used; it would need connectivity and
   * would race.
   *
   * CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0: blocks were previously held
   * PER TERMINAL (contiguous ranges within the branch, so terminals never
   * overlapped) even though the advisory lock below already serialises at
   * (branch, business day) granularity — the only concurrency boundary that
   * actually matters here. POS is a branch/employee-scoped application
   * session with no terminal identity any more, so this now allocates from
   * a SINGLE block held per (branch, business day); `order_number_blocks
   * .terminal_id` is written `null` and kept only as a legacy, unused
   * column (see the schema comment).
   */
  private async allocateOrderNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    branchCode: string,
    businessDay: Date,
  ): Promise<string> {
    // Serialise allocation for this (branch, business day).
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'ros_order_number',
      `${branchId}:${businessDay.toISOString().slice(0, 10)}`,
    );

    const existing = await tx.orderNumberBlock.findFirst({
      where: { branchId, businessDay, exhaustedAt: null },
      orderBy: { blockStart: 'desc' },
    });

    let block = existing;
    if (!block || block.nextSeq > block.blockEnd) {
      if (block) {
        await tx.orderNumberBlock.update({
          where: { id: block.id },
          data: { exhaustedAt: new Date() },
        });
      }
      // Contiguous with whatever this BRANCH has already issued.
      const highest = await tx.orderNumberBlock.findFirst({
        where: { branchId, businessDay },
        orderBy: { blockEnd: 'desc' },
        select: { blockEnd: true },
      });
      const fresh = makeBlock(
        nextBlockStart(highest?.blockEnd ?? null),
        DEFAULT_BLOCK_SIZE,
      );
      block = await tx.orderNumberBlock.create({
        data: {
          id: newId(),
          tenantId,
          branchId,
          businessDay,
          blockStart: fresh.blockStart,
          blockEnd: fresh.blockEnd,
          nextSeq: fresh.nextSeq,
        },
      });
    }

    const { seq, block: advanced } = takeNext({
      blockStart: block.blockStart,
      blockEnd: block.blockEnd,
      nextSeq: block.nextSeq,
    });
    await tx.orderNumberBlock.update({
      where: { id: block.id },
      data: { nextSeq: advanced.nextSeq },
    });

    return formatOrderNumber(branchCode, seq);
  }

  async create(tenantId: string, actorUserId: string, input: CreateOrderInput) {
    // FR-OFF-015: accept the device's identifier, validate it, keep it.
    const id = input.id ?? newId();
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException(
        'Order id must be a ULID rendered as a UUID.',
      );
    }
    const at = input.at ?? new Date();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // Branch supplies the currency, the code the order number is built from,
        // the timezone/cutover the business day comes from, and the jurisdiction
        // the country pack is selected by (FR-BRN-002/003). Invisible
        // cross-tenant under RLS -> 404, never 403. CROSSCUT-POS-KDS-
        // TERMINAL-DECOUPLING-P0: the branch is now trusted directly from
        // the caller's live-verified POS session (`input.branchId`), never
        // derived from a terminal registration.
        const branch = await tx.branch.findUnique({
          where: { id: input.branchId },
          select: {
            id: true,
            code: true,
            baseCurrency: true,
            countryCode: true,
            timezone: true,
            operatingHours: {
              select: { dayOfWeek: true, businessDayCutover: true },
            },
          },
        });
        if (!branch) throw new NotFoundException('Branch not found.');

        const employee = await tx.employee.findUnique({
          where: { id: input.openedByEmployeeId },
          select: { id: true, branches: { select: { branchId: true } } },
        });
        if (!employee) throw new NotFoundException('Employee not found.');
        // Same permitted-branch rule PIN authentication uses (FR-SEC-021).
        if (!employee.branches.some((b) => b.branchId === branch.id)) {
          throw new BadRequestException(
            'That employee is not permitted to open orders at this branch.',
          );
        }

        // FR-FIN-024: the day the sale is booked to is derived, never supplied.
        const businessDay = resolveBusinessDay(
          at,
          branch.timezone,
          cutoverLookup(branch.operatingHours),
        );

        // FR-LOC-021: the pack version in force for this branch at this instant.
        // Throws when no signed, effective pack is activated, so the column is
        // never filled with a placeholder.
        const pack = this.countryPacks.requireEffectiveFor(branch, at);

        // P2D (ratified P2D-R1 clause 7) — resolve the winning
        // ServiceChargePolicy version at the SAME instant `at`, through
        // the PUBLISHED Organisation contract only (never a raw
        // `tx.branch` read for the brand id — Branch.brandId is NOT NULL,
        // so every branch has exactly one; `null` here would only mean
        // this branch is momentarily not RLS-visible in its OWN
        // transaction, which fails closed to "no brand in scope" rather
        // than failing order creation itself).
        const branchFacts = await this.branchBrand.findBranchAuthorizationFacts(
          tx,
          branch.id,
        );
        const serviceChargeBreakdown = await this.serviceChargePolicies.resolve(
          tx,
          {
            tenantId,
            brandId: branchFacts?.brandId ?? null,
            branchId: branch.id,
            at,
          },
        );

        const orderNumber = await this.allocateOrderNumber(
          tx,
          tenantId,
          branch.id,
          branch.code,
          businessDay,
        );

        // Migration 35 (DayClose) cutover fence, checked AFTER the
        // advisory-lock acquisition above and BEFORE the INSERT below — the
        // pre-ratification final correction §4.4 "Option B" half of the
        // shared fence. A day sealed while this transaction was blocked on
        // the lock is now visible; a day that seals AFTER this check either
        // blocks on the same lock (if DayClose has not yet started) or has
        // already lost the race for it (both interleavings proved safe).
        const dayClosed = await this.dayCloseState.isClosed(tx, {
          tenantId,
          branchId: branch.id,
          businessDay,
        });
        if (dayClosed) {
          throw new ConflictException('That business day is closed.');
        }

        const order = await tx.order.create({
          data: {
            id,
            tenantId,
            branchId: branch.id,
            orderNumber,
            businessDay,
            orderType: input.orderType as never,
            channel: input.channel as never,
            state: 'draft',
            tableId: input.tableId ?? null,
            guestCount: input.guestCount ?? null,
            openedBy: input.openedByEmployeeId,
            currency: branch.baseCurrency,
            openedAt: at,
            originDeviceTime: input.originDeviceTime,
            idempotencyKey: input.idempotencyKey,
            countryPackVersion: pack.version,
            serviceChargePolicyVersionId:
              serviceChargeBreakdown.winner?.id ?? null,
            notes: input.notes ?? null,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_CREATED,
          entityType: AUDIT_ENTITY.ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            orderType: order.orderType,
            branchId: order.branchId,
            businessDay: order.businessDay.toISOString().slice(0, 10),
            state: order.state,
            // FR-LOC-021: the audit trail records which jurisdiction rules the
            // order was opened under, so the entry stays interpretable.
            countryPack: `${pack.code}-${pack.version}`,
          },
        });

        return order;
      },
    );
  }

  /**
   * Change state under optimistic concurrency (§24.6.4).
   *
   * The version assertion happens before any write, so a stale caller produces
   * no partial state change and no audit event.
   */
  async transition(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    to: OrderState,
    expectedVersion: number,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await tx.order.findUnique({
          where: { id_businessDay: { id: orderId, businessDay } },
        });
        if (!order) throw new NotFoundException('Order not found.');

        assertOrderMutable(order.state);
        const nextVersion = assertVersion(order.version, expectedVersion);
        // Legality of the transition itself is asserted by the caller through
        // `assertTransition`; this method carries the concurrency guarantee.

        const updated = await tx.order.update({
          where: { id_businessDay: { id: orderId, businessDay } },
          data: {
            state: to as never,
            version: nextVersion,
            updatedAt: new Date(),
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_STATE_CHANGED,
          entityType: AUDIT_ENTITY.ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: orderId,
          before: { state: order.state, version: order.version },
          metadata: { state: updated.state, version: updated.version },
        });
        return updated;
      },
    );
  }

  findOne(tenantId: string, orderId: string, businessDay: Date) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.order.findUnique({
        where: { id_businessDay: { id: orderId, businessDay } },
        include: { lines: { orderBy: { sequence: 'asc' } } },
      }),
    );
  }

  /**
   * List orders visible in the tenant context, newest business day first.
   *
   * Cursor pagination rather than offset: `sales.orders` is partitioned and
   * grows without bound, so an OFFSET scan would degrade and could skip or
   * repeat rows as new orders arrive mid-page. The cursor is the composite
   * primary key (business_day, id), which is exactly what the ordering is
   * unique on.
   */
  async list(
    tenantId: string,
    options: {
      branchId?: string;
      cursor?: { businessDay: Date; id: string };
      limit?: number;
    } = {},
  ) {
    const take = Math.min(Math.max(options.limit ?? 50, 1), 100);
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const rows = await tx.order.findMany({
        where: {
          ...(options.branchId ? { branchId: options.branchId } : {}),
          ...(options.cursor
            ? {
                OR: [
                  { businessDay: { lt: options.cursor.businessDay } },
                  {
                    businessDay: options.cursor.businessDay,
                    id: { lt: options.cursor.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ businessDay: 'desc' }, { id: 'desc' }],
        take: take + 1,
      });
      const page = rows.slice(0, take);
      const next = rows.length > take ? page[page.length - 1] : null;
      return {
        orders: page,
        nextCursor: next
          ? {
              businessDay: next.businessDay.toISOString().slice(0, 10),
              id: next.id,
            }
          : null,
      };
    });
  }
}
