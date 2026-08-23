import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PriceListScope, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { toPriceEntryView, toPriceListView } from '../catalogue.views';
import {
  findConflicting,
  isExclusionViolation,
} from '../pricing/price-list-overlap';
import { assertPriceCompleteness } from '../pricing/price-completeness';

export interface CreatePriceListInput {
  name: string;
  scopeType: PriceListScope;
  scopeId?: string;
  orderType?: string;
  validFrom?: string;
  validTo?: string;
  recurrenceRule?: Record<string, unknown>;
  priority?: number;
  status?: string;
}

export interface SetPriceEntryInput {
  menuItemVariantId: string;
  price: string;
  currency: string;
}

/**
 * PriceList / PriceEntry (FR-MNU-020…024, SRS §7.3 #10).
 *
 * C-06: scope is `tenant | brand | branch` ONLY. `branch_group` is not
 * implemented and is not claimed — ADR 0008 D-10 deferred branch groups, so
 * FR-MNU-020's fourth scope has no target entity.
 *
 * `scopeId` is polymorphic (three possible target tables), so no FK is possible;
 * the service validates it against the acting tenant instead — a cross-tenant
 * brand/branch id is rejected because it is invisible under RLS.
 *
 * C-10: there is NO `price_change_history` table. FR-MNU-024's price history is
 * recorded in the tamper-evident `governance.audit_entries` trail, with before
 * and after price, actor and tenant.
 */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertScope(
    tx: Prisma.TransactionClient,
    tenantId: string,
    scopeType: PriceListScope,
    scopeId: string | undefined,
  ): Promise<string | null> {
    if (scopeType === 'tenant') {
      if (scopeId !== undefined && scopeId !== tenantId) {
        throw new BadRequestException(
          'For tenant scope, scopeId must be omitted or equal the acting tenant.',
        );
      }
      return tenantId;
    }
    if (!scopeId) {
      throw new BadRequestException(
        `scopeId is required for ${scopeType} scope.`,
      );
    }
    // RLS makes another tenant's brand/branch invisible → 404, not 403.
    if (scopeType === 'brand') {
      const brand = await tx.brand.findUnique({ where: { id: scopeId } });
      if (!brand) throw new NotFoundException('Brand not found.');
    } else {
      const branch = await tx.branch.findUnique({ where: { id: scopeId } });
      if (!branch) throw new NotFoundException('Branch not found.');
    }
    return scopeId;
  }

  async create(tenantId: string, actorId: string, input: CreatePriceListInput) {
    try {
      return await this.createChecked(tenantId, actorId, input);
    } catch (err) {
      // The pre-check inside `createChecked` cannot see a concurrent writer's
      // uncommitted row, so the database constraint is what actually decides.
      // Its loser gets the same 409, not a 500.
      if (isExclusionViolation(err)) {
        throw new ConflictException(
          'Another price list already covers this scope at this priority for an ' +
            'overlapping validity window. SRS §7.3 forbids overlapping windows of ' +
            'the same priority for the same scope.',
        );
      }
      throw err;
    }
  }

  private async createChecked(
    tenantId: string,
    actorId: string,
    input: CreatePriceListInput,
  ) {
    const list = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const scopeId = await this.assertScope(
          tx,
          tenantId,
          input.scopeType,
          input.scopeId,
        );

        // SRS §7.3 #10 — no overlapping windows of same priority for same scope.
        // This pre-check exists to return a clear 409 naming the conflicting
        // list; the authoritative guarantee is the exclusion constraint
        // `ex_price_list_no_overlap`, which also holds under concurrency.
        const candidate = {
          scopeType: input.scopeType,
          scopeId,
          priority: input.priority ?? 0,
          validFrom: input.validFrom ? new Date(input.validFrom) : null,
          validTo: input.validTo ? new Date(input.validTo) : null,
        };
        const siblings = await tx.priceList.findMany({
          where: { scopeType: input.scopeType, scopeId },
          select: {
            id: true,
            name: true,
            scopeType: true,
            scopeId: true,
            priority: true,
            validFrom: true,
            validTo: true,
          },
        });
        const clash = findConflicting(candidate, siblings);
        if (clash) {
          throw new ConflictException(
            `Price list "${clash.name}" already covers this scope at this ` +
              'priority for an overlapping validity window. SRS §7.3 forbids ' +
              'overlapping windows of the same priority for the same scope — use a ' +
              'different priority or a non-overlapping validity window.',
          );
        }

        const created = await tx.priceList.create({
          data: {
            id: newId(),
            tenantId,
            name: input.name,
            scopeType: input.scopeType,
            scopeId,
            orderType: input.orderType ?? null,
            validFrom: input.validFrom ? new Date(input.validFrom) : null,
            validTo: input.validTo ? new Date(input.validTo) : null,
            ...(input.recurrenceRule !== undefined
              ? {
                  recurrenceRule: input.recurrenceRule as Prisma.InputJsonValue,
                }
              : {}),
            ...(input.priority !== undefined
              ? { priority: input.priority }
              : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
          },
        });
        // C-11 (amended): an administratively ACTIVE list must be complete the
        // moment it exists. A future `valid_from` does NOT weaken this gate.
        if (created.status === 'active') {
          await assertPriceCompleteness(
            tx,
            { priceListId: created.id },
            'This price list cannot be created as active while it is incomplete.',
          );
        }

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PRICE_LIST_CREATED,
          entityType: AUDIT_ENTITY.PRICE_LIST,
          actorType: 'user',
          actorId,
          entityId: created.id,
          metadata: {
            name: created.name,
            scopeType: created.scopeType,
            scopeId: created.scopeId,
            priority: created.priority,
          },
        });
        return created;
      },
    );
    return toPriceListView(list);
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.priceList.findMany({ orderBy: { priority: 'desc' } }),
      )
      .then((rows) => rows.map(toPriceListView));
  }

  async findOne(tenantId: string, priceListId: string) {
    const list = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.priceList.findUnique({ where: { id: priceListId } }),
    );
    if (!list) {
      throw new NotFoundException('Price list not found.');
    }
    return toPriceListView(list);
  }

  /**
   * FR-MNU-023/024: set a variant's price in a list. The audit entry carries the
   * previous and new price, so the tamper-evident trail is the price history.
   *
   * C-11: this does NOT require the list to cover every variant, and creating a
   * variant does not require an entry here — no circular write dependency.
   */
  async setPriceEntry(
    tenantId: string,
    actorId: string,
    priceListId: string,
    input: SetPriceEntryInput,
  ) {
    let price: bigint;
    try {
      price = BigInt(input.price);
    } catch {
      throw new BadRequestException(
        'price must be an integer string in minor currency units.',
      );
    }

    try {
      const entry = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const list = await tx.priceList.findUnique({
            where: { id: priceListId },
          });
          if (!list) {
            throw new NotFoundException('Price list not found.');
          }
          const existing = await tx.priceEntry.findUnique({
            where: {
              tenantId_priceListId_menuItemVariantId: {
                tenantId,
                priceListId,
                menuItemVariantId: input.menuItemVariantId,
              },
            },
          });
          const saved = existing
            ? await tx.priceEntry.update({
                where: { id: existing.id },
                data: { price, currency: input.currency },
              })
            : await tx.priceEntry.create({
                data: {
                  id: newId(),
                  tenantId,
                  priceListId,
                  menuItemVariantId: input.menuItemVariantId,
                  price,
                  currency: input.currency,
                },
              });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.PRICE_ENTRY_SET,
            entityType: AUDIT_ENTITY.PRICE_ENTRY,
            actorType: 'user',
            actorId,
            entityId: saved.id,
            before: existing
              ? {
                  price: existing.price.toString(),
                  currency: existing.currency,
                }
              : null,
            metadata: {
              priceListId,
              menuItemVariantId: saved.menuItemVariantId,
              price: saved.price.toString(),
              currency: saved.currency,
              effectiveFrom: list.validFrom?.toISOString() ?? null,
            },
          });
          return saved;
        },
      );
      return toPriceEntryView(entry);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, 'Variant not found.');
    }
  }

  /**
   * Transition a price list to `active`, enforcing C-11 as amended.
   *
   * NO PUBLIC HTTP SURFACE EXISTS for this: the catalogue controller exposes no
   * price-list status route, and inventing one solely to satisfy this task was
   * out of scope. This is the internal application service the invariant hangs
   * on; when an activation endpoint is added it must call through here. The
   * absent public surface is reported rather than papered over.
   */
  async activate(tenantId: string, actorId: string, priceListId: string) {
    const list = await this.prisma.withAuthContext(
      { userId: actorId, tenantId },
      async (tx) => {
        const existing = await tx.priceList.findUnique({
          where: { id: priceListId },
          select: { id: true, status: true },
        });
        if (!existing) {
          throw new NotFoundException('Price list not found.');
        }

        await assertPriceCompleteness(
          tx,
          { priceListId, assumeListActive: priceListId },
          'This price list cannot be activated while it is incomplete.',
        );

        const updated = await tx.priceList.update({
          where: { id: priceListId },
          data: { status: 'active' },
        });
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PRICE_LIST_CREATED,
          entityType: AUDIT_ENTITY.PRICE_LIST,
          actorType: 'user',
          actorId,
          entityId: updated.id,
          before: { status: existing.status },
          metadata: { status: updated.status, name: updated.name },
        });
        return updated;
      },
    );
    return toPriceListView(list);
  }

  listEntries(tenantId: string, priceListId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        const list = await tx.priceList.findUnique({
          where: { id: priceListId },
        });
        if (!list) {
          throw new NotFoundException('Price list not found.');
        }
        return tx.priceEntry.findMany({ where: { priceListId } });
      })
      .then((rows) => rows.map(toPriceEntryView));
  }
}
