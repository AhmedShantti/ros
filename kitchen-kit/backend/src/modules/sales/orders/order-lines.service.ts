/**
 * OrderLine capture — BR-POS-004, in full.
 *
 * "item_name_snapshot, unit_price, tax_class_id, unit_cost_snapshot, and
 * recipe_version_id SHALL be captured at the time of sale and SHALL NOT be
 * recomputed from current master data."
 *
 * Every one of those five is now produced by a real source, which is why this
 * command exists at all:
 *
 *   item_name_snapshot   `catalogue.menu_items.names` + the variant's own name,
 *                        copied, never joined to later
 *   unit_price           the canonical `PriceResolutionService` (FR-POS-040),
 *                        run on THIS transaction so pricing has one implementation
 *   tax_class_id         `fiscal.tax_classes` UUID (C-04 AMENDMENT), refused
 *                        rather than defaulted when the item has none
 *   unit_cost_snapshot   BR-MNU-003 recipe cost under each component's own
 *                        costing method (D-17-05 NARROW AMENDMENT)
 *   recipe_version_id    the PUBLISHED version for the variant at this branch's
 *                        scope (D-17-03 precedence, D-17-08 selection)
 *
 * ── NOTHING FINANCIAL COMES FROM THE CLIENT ────────────────────────────────
 * The request carries an identity, a menu item, a variant, a quantity and
 * modifier selections. Price, tax, cost, subtotal and total are all derived
 * here; the DTO does not even have fields for them, so there is nothing to
 * ignore — a client cannot express the attempt.
 *
 * ── WHY THE WHOLE THING IS ONE TRANSACTION ─────────────────────────────────
 * The version assertion, the line insert, the modifier snapshots, the order
 * total recomputation, the version increment and the audit entry all commit
 * together or not at all. A partially-applied line would leave an order whose
 * totals disagree with its lines, which is unrecoverable without manual repair.
 */

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UUID_PATTERN, newId } from '../../../common/ids';
import { Money } from '../../../common/money/money';
import {
  Rational,
  add,
  fromExactDecimal,
  multiply,
  rational,
  toMinorUnits,
} from '../../../common/money/rational';
import {
  RoundingMode,
  parseExactDecimal,
} from '../../../common/money/rounding';
import type { ExactDecimal } from '../../../common/money/rounding';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PriceResolutionService } from '../../catalogue/pricing/price-resolution.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
import { TaxClassService } from '../../localisation/tax/tax-class.service';
import { TaxEngineRegistry } from '../../localisation/tax/tax-engine.registry';
import { computeLineTax } from '../../localisation/tax/tax.calculator';
import type { LineTaxResult } from '../../localisation/tax/tax.model';
import { RecipeCostService } from '../../production/costing/recipe-cost.service';
import { PRODUCTION_CONSUMPTION_QUERY } from '../../production/contract';
import type { ProductionConsumptionQuery } from '../../production/contract';
import {
  resolveRecipeByScope,
  selectPublishedVersion,
} from '../../production/recipe-graph';
import {
  assertCashierMayMutateLine,
  assertMayAddLine,
  assertVersion,
} from './order-state';

/** Quantity is DECIMAL(12,3): fractional sales are real (0.5 kg of meat). */
const QUANTITY_SCALE = 3;

export interface AddLineModifierInput {
  readonly modifierId: string;
  readonly quantity?: number;
}

export interface AddLineInput {
  /** FR-OFF-015 — the device's ULID for the line. Preserved exactly. */
  readonly id?: string;
  readonly menuItemId: string;
  readonly variantId: string;
  /** Exact decimal string, at most 3 dp. */
  readonly quantity: string;
  readonly modifiers?: readonly AddLineModifierInput[];
  readonly course?: number | null;
  readonly seatNumber?: number | null;
  readonly notes?: string | null;
  /** If-Match — the order version the caller believes it is editing. */
  readonly expectedVersion: number;
}

export interface VoidLineInput {
  readonly expectedVersion: number;
  /** REQUIRED — FR-POS-013, and `ck_order_line_void_reason` enforces it. */
  readonly reasonCodeId: string;
}

/**
 * How the sale-time cost was obtained.
 *
 * Recorded in the AUDIT payload only — deliberately NOT a column. The order line
 * already carries everything needed to tell the three cases apart:
 * `recipe_version_id IS NULL` is the absent case by definition, and for the
 * other two the referenced version answers the question. Adding a column would
 * duplicate derivable state and create a second thing to keep in step.
 *
 * It is on the audit entry because an audit trail records what the system KNEW
 * at the time, which is not the same as what can be re-derived later: a recipe
 * incomplete at sale time may be complete by the time anyone looks.
 */
type CostBasis =
  | 'recipe_complete'
  | 'recipe_incomplete_br_mnu_012'
  | 'recipe_absent_br_mnu_012';

interface ResolvedUnitCost {
  readonly unitCostMinorUnits: bigint;
  readonly recipeVersionId: string | null;
  readonly basis: CostBasis;
}

/**
 * BR-MNU-012's absent-recipe outcome, in one place so both paths that reach it
 * cannot drift apart.
 *
 * `recipe_version_id = NULL` here means exactly one thing: NO RECIPE EXISTED AT
 * SALE TIME. It never means "the cost computation failed" — that case throws.
 * No sentinel id, no placeholder Recipe row and no zero UUID is created to
 * avoid the null.
 */
const ABSENT_RECIPE_COST: ResolvedUnitCost = {
  unitCostMinorUnits: 0n,
  recipeVersionId: null,
  basis: 'recipe_absent_br_mnu_012',
};

@Injectable()
export class OrderLinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PriceResolutionService,
    private readonly countryPacks: CountryPackService,
    private readonly taxClasses: TaxClassService,
    private readonly taxEngines: TaxEngineRegistry,
    private readonly recipeCost: RecipeCostService,
    // P1F-2 — Production's PUBLIC contract only (KNOWN_DEVIATIONS must not
    // grow); the pre-existing direct `RecipeCostService` import above is
    // documented debt, not a precedent to extend.
    @Inject(PRODUCTION_CONSUMPTION_QUERY)
    private readonly consumption: ProductionConsumptionQuery,
  ) {}

  async addLine(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    input: AddLineInput,
  ) {
    const lineId = input.id ?? newId();
    if (!UUID_PATTERN.test(lineId)) {
      throw new BadRequestException(
        'Line id must be a ULID rendered as a UUID.',
      );
    }
    const quantity = this.parseQuantity(input.quantity);

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await tx.order.findUnique({
          where: { id_businessDay: { id: orderId, businessDay } },
          select: {
            id: true,
            businessDay: true,
            branchId: true,
            terminalId: true,
            orderType: true,
            state: true,
            version: true,
            currency: true,
            countryPackVersion: true,
            subtotal: true,
            taxTotal: true,
            discountTotal: true,
            serviceChargeTotal: true,
          },
        });
        // Cross-tenant orders are invisible under RLS -> 404, never 403.
        if (!order) throw new NotFoundException('Order not found.');

        // Clarification B/C: content may change only pre-finalisation, and the
        // order must be in a state that accepts lines at all.
        assertMayAddLine(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        const branch = await tx.branch.findUnique({
          where: { id: order.branchId },
          select: {
            id: true,
            brandId: true,
            countryCode: true,
            baseCurrency: true,
          },
        });
        if (!branch) throw new NotFoundException('Branch not found.');

        // FR-LOC-021: the EXACT version the order was opened under. Never the
        // version in force today — that would re-tax a sale at a new rate.
        const pack = this.countryPacks.requirePinned(
          branch.countryCode,
          order.countryPackVersion,
        );

        const { menuItem, variant } = await this.loadSellable(
          tx,
          input.menuItemId,
          input.variantId,
        );
        await this.assertAvailable(tx, order.branchId, menuItem.id, variant.id);

        // -------------------------------------------------- price + provenance
        const resolution = await this.pricing.resolveIn(tx, {
          branchId: order.branchId,
          menuItemVariantId: variant.id,
          orderType: order.orderType,
        });
        if (!resolution.resolved) {
          throw new UnprocessableEntityException(
            resolution.ambiguous
              ? 'Two price lists tie for this item; the price is ambiguous and the ' +
                  'line cannot be captured.'
              : 'No active price applies to this item at this branch and order type.',
          );
        }
        const priced = resolution.resolved;
        if (priced.amount.currency.code !== order.currency) {
          throw new UnprocessableEntityException(
            `This item is priced in ${priced.amount.currency.code} but the order ` +
              `is in ${order.currency}.`,
          );
        }

        // -------------------------------------------------------- modifiers
        const modifiers = await this.resolveModifiers(
          tx,
          menuItem.id,
          input.modifiers ?? [],
        );
        const modifierTotal = modifiers.reduce(
          (sum, m) => sum + m.priceDelta * BigInt(m.quantity),
          0n,
        );

        // ------------------------------------------------------- line money
        // unit_price is the price of ONE unit before modifiers (SRS 7.4.2).
        const unitPrice = priced.amount;
        const extended = unitPrice.times(input.quantity, pack.tax.roundingMode);
        const lineSubtotal = extended.amount + modifierTotal;

        // ------------------------------------------------------------- tax
        const taxClass = await this.taxClasses.requireForSale(
          tx,
          menuItem.id,
          branch.countryCode,
        );
        let lineTax: LineTaxResult;
        try {
          lineTax = computeLineTax(pack, this.taxEngines, {
            taxableBase: Money.of(lineSubtotal, order.currency),
            taxClassCode: taxClass.code,
            orderType: order.orderType,
          });
        } catch (error) {
          // A class the item names but the pinned pack does not define is a
          // configuration failure, not a reason to substitute `standard`.
          throw new UnprocessableEntityException((error as Error).message);
        }

        // ------------------------------------------------------------ cost
        const cost = await this.resolveUnitCost(
          tx,
          variant.id,
          branch,
          quantity,
        );

        // --------------------------------------------------------- persist
        const sequence = await this.nextSequence(tx, order.id, businessDay);
        const lineTotal =
          pack.tax.pricingMode === 'tax_inclusive'
            ? lineSubtotal
            : lineSubtotal + lineTax.taxAmount.amount;

        const line = await tx.orderLine.create({
          data: {
            id: lineId,
            tenantId,
            orderId: order.id,
            businessDay,
            sequence,
            menuItemId: menuItem.id,
            variantId: variant.id,
            // BR-POS-004 snapshots. Copied now; never re-derived.
            itemNameSnapshot: {
              item: menuItem.names,
              variant: variant.name,
            },
            quantity: new Prisma.Decimal(input.quantity),
            unitPrice: unitPrice.amount,
            modifierTotal,
            lineDiscount: 0n,
            lineSubtotal,
            taxClassId: taxClass.id,
            taxAmount: lineTax.taxAmount.amount,
            lineTotal,
            unitCostSnapshot: cost.unitCostMinorUnits,
            recipeVersionId: cost.recipeVersionId,
            // FR-POS-042 provenance.
            priceListId: priced.priceListId,
            priceEntryId: priced.priceEntryId,
            priceRule: priced.rule.slice(0, 160),
            course: input.course ?? null,
            seatNumber: input.seatNumber ?? null,
            state: 'pending',
            notes: input.notes ?? null,
          },
        });

        // orderLineModifierId is the FK target `order_line_modifier_effects`
        // needs — captured as each row is created so the P1F-2 snapshot
        // below can reference the right one.
        const orderLineModifierIdByModifierId = new Map<string, string>();
        for (const modifier of modifiers) {
          const orderLineModifierId = newId();
          orderLineModifierIdByModifierId.set(modifier.id, orderLineModifierId);
          await tx.orderLineModifier.create({
            data: {
              id: orderLineModifierId,
              tenantId,
              orderLineId: line.id,
              businessDay,
              modifierId: modifier.id,
              modifierGroupId: modifier.modifierGroupId,
              nameSnapshot: modifier.name as Prisma.InputJsonValue,
              // FR-POS-021 / BR-POS-004: copied verbatim from the source
              // Modifier at capture time — `null` stays `null` (P1E-5; never
              // defaulted to a guessed kind).
              kindSnapshot: modifier.kind,
              priceDelta: modifier.priceDelta,
              quantity: modifier.quantity,
            },
          });
        }

        // ---------------------------------------- P1F-2 LINE-CAPTURE PINS
        // Production's PUBLIC contract only (KNOWN_DEVIATIONS does not
        // grow) — resolves the recipe-version closure, the pinned modifier
        // effects, and the pinned unit-conversion factors, and NOTHING
        // resolved/net and NO money. Persisted verbatim, same transaction.
        const modifierIds = modifiers.map((m) => m.id);
        const basis = await this.consumption.resolveConsumptionBasis(tx, {
          tenantId,
          recipeVersionId: cost.recipeVersionId,
          modifierIds,
        });

        if (basis.versionClosure.length) {
          await tx.orderLineRecipeVersion.createMany({
            data: basis.versionClosure.map((entry) => ({
              id: newId(),
              tenantId,
              businessDay,
              orderLineId: line.id,
              recipeVersionId: entry.recipeVersionId,
              depth: entry.depth,
            })),
          });
        }

        const removeAllStockItemIds: string[] = [];
        const modifierEffectRows: Prisma.OrderLineModifierEffectCreateManyInput[] =
          [];
        for (const modifierId of modifierIds) {
          const orderLineModifierId =
            orderLineModifierIdByModifierId.get(modifierId);
          if (!orderLineModifierId) continue;
          for (const effect of basis.modifierEffects.get(modifierId) ?? []) {
            if (effect.operation === 'remove_all' && effect.stockItemId) {
              removeAllStockItemIds.push(effect.stockItemId);
            }
            modifierEffectRows.push({
              id: newId(),
              tenantId,
              businessDay,
              orderLineId: line.id,
              orderLineModifierId,
              operation: effect.operation,
              componentType: effect.componentType,
              stockItemId: effect.stockItemId,
              subRecipeVersionId: effect.subRecipeVersionId,
              quantity: effect.quantity
                ? new Prisma.Decimal(effect.quantity)
                : null,
              unitId: effect.unitId,
              sequence: effect.sequence,
            });
          }
        }
        if (modifierEffectRows.length) {
          await tx.orderLineModifierEffect.createMany({
            data: modifierEffectRows,
          });
        }

        if (basis.conversions.length) {
          await tx.orderLineComponentConversion.createMany({
            data: basis.conversions.map((c) => ({
              id: newId(),
              tenantId,
              businessDay,
              orderLineId: line.id,
              stockItemId: c.stockItemId,
              fromUnitId: c.fromUnitId,
              baseUnitId: c.baseUnitId,
              factor: new Prisma.Decimal(c.factor),
            })),
          });
        }

        const totals = await this.recomputeOrderTotals(
          tx,
          order.id,
          businessDay,
          order.currency,
        );

        const updated = await tx.order.update({
          where: { id_businessDay: { id: order.id, businessDay } },
          data: {
            ...totals,
            version: nextVersion,
            updatedAt: new Date(),
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_LINE_ADDED,
          entityType: AUDIT_ENTITY.ORDER_LINE,
          actorType: 'user',
          actorId: actorUserId,
          entityId: line.id,
          terminalId: order.terminalId,
          metadata: {
            orderId: order.id,
            branchId: order.branchId,
            businessDay: businessDay.toISOString().slice(0, 10),
            sequence,
            menuItemId: menuItem.id,
            variantId: variant.id,
            quantity: input.quantity,
            unitPrice: unitPrice.amount.toString(),
            lineSubtotal: lineSubtotal.toString(),
            taxAmount: lineTax.taxAmount.amount.toString(),
            lineTotal: lineTotal.toString(),
            // The identities that make the snapshot auditable years later.
            countryPack: `${pack.code}-${pack.version}`,
            taxClassId: taxClass.id,
            taxClassCode: taxClass.code,
            recipeVersionId: cost.recipeVersionId,
            unitCostSnapshot: cost.unitCostMinorUnits.toString(),
            costBasis: cost.basis,
            priceListId: priced.priceListId,
            priceEntryId: priced.priceEntryId,
            orderVersion: nextVersion,
            // P1F-2 — applied REMOVE_ALL operations, recorded here (not a
            // column): an audit trail records what the system KNEW at
            // capture time.
            removeAllStockItemIds,
            // P1F-2 acceptance closure §5 — a modifier ADD effect targeting a
            // sub-recipe with no published version at capture time cannot be
            // persisted into `order_line_modifier_effects` (its XOR CHECK
            // requires a non-null pin) and is dropped from the snapshot. That
            // drop is recorded here so it is not silently forgotten with zero
            // evidence anywhere in the system — a STRUCTURAL gap, not a
            // valuation failure; the sale still proceeds.
            droppedModifierEffects: basis.droppedModifierEffects,
          },
        });

        return { line, order: updated };
      },
    );
  }

  /**
   * Void a line before it is fired — the cashier's ordinary correction.
   *
   * Clarification C: BEFORE fire the cashier corrects normally; AFTER fire the
   * cashier may not touch fired content and the privileged path is deliberately
   * unimplemented. `assertCashierMayMutateLine` is the single place that decides,
   * so a direct service call cannot bypass it either.
   *
   * The row is VOIDED, never deleted. A deleted line leaves no evidence that an
   * item was rung up and removed, which is the oldest till fraud there is.
   */
  async voidLinePreFire(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    lineId: string,
    input: VoidLineInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await tx.order.findUnique({
          where: { id_businessDay: { id: orderId, businessDay } },
          select: {
            id: true,
            state: true,
            version: true,
            currency: true,
            branchId: true,
            terminalId: true,
          },
        });
        if (!order) throw new NotFoundException('Order not found.');

        const line = await tx.orderLine.findUnique({
          where: { id_businessDay: { id: lineId, businessDay } },
          select: { id: true, orderId: true, state: true, lineTotal: true },
        });
        if (!line || line.orderId !== order.id) {
          throw new NotFoundException('Order line not found.');
        }

        assertCashierMayMutateLine(order.state, line.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        // FR-POS-013: a void carries a reason. Read tenant-scoped, so a reason
        // code from another tenant is invisible and cannot be attached.
        const reason = await tx.reasonCode.findUnique({
          where: { id: input.reasonCodeId },
          select: { id: true },
        });
        if (!reason) {
          throw new UnprocessableEntityException(
            'A void requires a reason code that exists in this tenant (FR-POS-013).',
          );
        }

        const voided = await tx.orderLine.update({
          where: { id_businessDay: { id: lineId, businessDay } },
          data: {
            state: 'voided',
            voidedBy: actorUserId,
            voidReasonId: reason.id,
          },
        });

        const totals = await this.recomputeOrderTotals(
          tx,
          order.id,
          businessDay,
          order.currency,
        );
        const updated = await tx.order.update({
          where: { id_businessDay: { id: order.id, businessDay } },
          data: { ...totals, version: nextVersion, updatedAt: new Date() },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.ORDER_LINE_VOIDED,
          entityType: AUDIT_ENTITY.ORDER_LINE,
          actorType: 'user',
          actorId: actorUserId,
          entityId: lineId,
          terminalId: order.terminalId,
          before: { state: line.state },
          metadata: {
            orderId: order.id,
            state: voided.state,
            orderVersion: nextVersion,
            reasonCodeId: reason.id,
          },
        });

        return { line: voided, order: updated };
      },
    );
  }

  // ------------------------------------------------------------- internals

  private parseQuantity(raw: string): Rational {
    let parsed: ExactDecimal;
    try {
      parsed = parseExactDecimal(raw);
    } catch {
      throw new BadRequestException(
        `Quantity ${JSON.stringify(raw)} is not an exact decimal.`,
      );
    }
    if (parsed.scale > QUANTITY_SCALE) {
      throw new BadRequestException(
        `Quantity supports at most ${QUANTITY_SCALE} decimal places.`,
      );
    }
    if (parsed.unscaled <= 0n) {
      throw new UnprocessableEntityException(
        'Quantity must be greater than zero.',
      );
    }
    return { num: parsed.unscaled, den: 10n ** BigInt(parsed.scale) };
  }

  private async loadSellable(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    variantId: string,
  ) {
    const menuItem = await tx.menuItem.findUnique({
      where: { id: menuItemId },
      select: { id: true, names: true, isActive: true, isOpenPrice: true },
    });
    if (!menuItem) throw new NotFoundException('Menu item not found.');
    if (!menuItem.isActive) {
      throw new UnprocessableEntityException('That item is not active.');
    }

    const variant = await tx.menuItemVariant.findUnique({
      where: { id: variantId },
      select: { id: true, menuItemId: true, name: true, isActive: true },
    });
    if (!variant) throw new NotFoundException('Menu item variant not found.');
    if (variant.menuItemId !== menuItem.id) {
      throw new UnprocessableEntityException(
        'That variant does not belong to this item.',
      );
    }
    if (!variant.isActive) {
      throw new UnprocessableEntityException('That variant is not active.');
    }
    return { menuItem, variant };
  }

  /**
   * FR-MNU-030/031 — refuse an item that has been 86'd.
   *
   * Deliberately NARROW: only `is_manual_86` is evaluated. The day/time window
   * columns on `availability_rules` exist but no source defines how they compose
   * with the P0-2 recurrence semantics, and guessing would either hide sellable
   * items or expose unsellable ones. The narrowing is stated rather than silent.
   */
  private async assertAvailable(
    tx: Prisma.TransactionClient,
    branchId: string,
    menuItemId: string,
    variantId: string,
  ): Promise<void> {
    const now = new Date();
    const blocked = await tx.availabilityRule.findFirst({
      where: {
        isManual86: true,
        OR: [{ menuItemId }, { variantId }],
        // A rule with no branch applies everywhere.
        AND: [{ OR: [{ branchId }, { branchId: null }] }],
      },
      select: { id: true, autoReenableAt: true },
    });
    if (!blocked) return;
    if (blocked.autoReenableAt && blocked.autoReenableAt <= now) return;
    throw new UnprocessableEntityException(
      'That item is currently unavailable (86) at this branch.',
    );
  }

  /**
   * Validate the modifier selection against its groups (FR-MNU-010/011) and
   * return the snapshot data.
   *
   * A modifier not attached to this item is rejected: otherwise a client could
   * attach a cheap group from another item and change what it pays.
   */
  private async resolveModifiers(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    selections: readonly AddLineModifierInput[],
  ) {
    const links = await tx.modifierGroupLink.findMany({
      where: { menuItemId },
      select: {
        modifierGroupId: true,
        group: {
          select: {
            id: true,
            minSelections: true,
            maxSelections: true,
            isRequired: true,
            allowRepeat: true,
            modifiers: {
              select: {
                id: true,
                name: true,
                kind: true,
                priceDelta: true,
                modifierGroupId: true,
              },
            },
          },
        },
      },
    });

    const byModifierId = new Map(
      links.flatMap((l) => l.group.modifiers.map((m) => [m.id, m] as const)),
    );

    const resolved = selections.map((selection) => {
      const modifier = byModifierId.get(selection.modifierId);
      if (!modifier) {
        throw new UnprocessableEntityException(
          'That modifier is not available for this item.',
        );
      }
      const quantity = selection.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new UnprocessableEntityException(
          'A modifier quantity must be a positive whole number.',
        );
      }
      return {
        id: modifier.id,
        modifierGroupId: modifier.modifierGroupId,
        name: modifier.name,
        kind: modifier.kind,
        priceDelta: modifier.priceDelta,
        quantity,
      };
    });

    // Cardinality, per group, including the groups the caller omitted entirely
    // — a required group that was not sent is exactly the case worth catching.
    for (const link of links) {
      const group = link.group;
      const chosen = resolved.filter((m) => m.modifierGroupId === group.id);
      const count = chosen.reduce((sum, m) => sum + m.quantity, 0);
      const distinct = new Set(chosen.map((m) => m.id)).size;

      if (group.isRequired && count < Math.max(group.minSelections, 1)) {
        throw new UnprocessableEntityException(
          'A required modifier group has too few selections.',
        );
      }
      if (count < group.minSelections && count > 0) {
        throw new UnprocessableEntityException(
          'A modifier group has fewer selections than it requires.',
        );
      }
      if (group.maxSelections > 0 && count > group.maxSelections) {
        throw new UnprocessableEntityException(
          'A modifier group has more selections than it permits.',
        );
      }
      if (!group.allowRepeat && distinct !== count) {
        throw new UnprocessableEntityException(
          'That modifier group does not allow repeating a selection.',
        );
      }
    }
    return resolved;
  }

  /**
   * The sale-time cost — BR-POS-004's `unit_cost_snapshot`, and BR-MNU-012's
   * exact boundary. Four outcomes, three of which sell:
   *
   *   ABSENT     no applicable recipe, or none published.
   *              -> recipe_version_id = NULL, unit_cost_snapshot = 0.
   *              BR-MNU-012's "SHALL record ZERO cost", literally. NULL would
   *              have meant "we could not work it out", which is a different
   *              and untrue statement.
   *
   *   INCOMPLETE the recipe exists but its DEFINITION is unfinished — no
   *              components, or a sub-recipe not yet published.
   *              -> real recipe_version_id, truthful PARTIAL cost from the
   *              components that are specified. Missing components contribute
   *              nothing; they are not priced as zero.
   *
   *   COMPLETE   definition finished, every component priceable.
   *              -> real recipe_version_id, full cost.
   *
   *   UNVALUABLE definition finished, but Inventory cannot price a component.
   *              -> REFUSED (422). This is NOT BR-MNU-012: the operator
   *              believes this dish is fully costed, and selling it at a
   *              silently reduced cost would under-report COGS on every unit.
   *              Fixing the ingredient's valuation is the operator's remedy.
   */
  private async resolveUnitCost(
    tx: Prisma.TransactionClient,
    variantId: string,
    branch: { id: string; brandId: string },
    quantity: Rational,
  ): Promise<ResolvedUnitCost> {
    const candidates = await tx.recipe.findMany({
      where: { menuItemVariantId: variantId },
      select: { id: true, scope: true, brandId: true, branchId: true },
    });
    // D-17-03 precedence: branch > brand > tenant. Reused, not reimplemented.
    const recipe = resolveRecipeByScope(
      candidates.map((c) => ({
        id: c.id,
        scope: c.scope,
        brandId: c.brandId,
        branchId: c.branchId,
      })),
      { branchId: branch.id, brandId: branch.brandId },
    );
    if (!recipe) return ABSENT_RECIPE_COST;

    const versions = await tx.recipeVersion.findMany({
      where: { recipeId: recipe.id },
      select: { id: true, version: true, status: true },
    });
    // D-17-08: the published version, with no date and no fallback.
    const published = selectPublishedVersion(
      versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
      })),
    );
    // A recipe identity with no PUBLISHED version has no definition in force,
    // so from the sale's point of view the recipe is absent, not incomplete:
    // there is no version id that could honestly be snapshotted.
    if (!published) return ABSENT_RECIPE_COST;

    const costed = await this.recipeCost.cost(tx, published.id);

    // The refusal. A finished recipe whose ingredient cannot be priced is a
    // data problem to fix, not a discount to absorb.
    if (costed.structurallyComplete && !costed.valuationComplete) {
      const missing = costed.gaps.map((g) => g.reason).join(', ');
      throw new UnprocessableEntityException(
        'This item has a complete recipe, but one of its components has no ' +
          `current valuation (${missing}). The sale is refused rather than ` +
          'recorded at an understated cost; value the component and retry. ' +
          'BR-MNU-012 covers an incomplete recipe, not an unpriced ingredient.',
      );
    }

    // Cost per SOLD unit = cost of one yield unit x quantity sold. Exact until
    // the single rounding below (BR-FIN-001).
    const forQuantity: Rational = {
      num: costed.perYieldUnit.num * quantity.num,
      den: costed.perYieldUnit.den * quantity.den,
    };

    return {
      unitCostMinorUnits: toMinorUnits(forQuantity, RoundingMode.HALF_UP),
      recipeVersionId: published.id,
      basis: costed.structurallyComplete
        ? 'recipe_complete'
        : 'recipe_incomplete_br_mnu_012',
    };
  }

  private async nextSequence(
    tx: Prisma.TransactionClient,
    orderId: string,
    businessDay: Date,
  ): Promise<number> {
    // A row lock on the ORDER serialises concurrent line adds, so two terminals
    // adding to one order cannot collide on `uq_order_line_sequence`. The
    // optimistic version check catches the same race, but this keeps the failure
    // a clean 409 rather than a unique-violation.
    const highest = await tx.orderLine.findFirst({
      where: { orderId, businessDay },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const next = (highest?.sequence ?? 0) + 1;
    if (next > 32_767) {
      throw new ConflictException('This order has too many lines.');
    }
    return next;
  }

  /**
   * FR-FIN-034 — the order's tax is the SUM of its line taxes, never a
   * computation on the order total.
   *
   * Voided and comped lines are excluded from the money: a voided line is
   * evidence, not revenue.
   */
  private async recomputeOrderTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
    businessDay: Date,
    currency: string,
  ): Promise<{
    subtotal: bigint;
    taxTotal: bigint;
    grandTotal: bigint;
    cogsTotal: bigint | null;
  }> {
    const lines = await tx.orderLine.findMany({
      where: {
        orderId,
        businessDay,
        state: { notIn: ['voided', 'comped'] },
      },
      select: {
        lineSubtotal: true,
        taxAmount: true,
        lineTotal: true,
        unitCostSnapshot: true,
        quantity: true,
      },
    });

    let subtotal = 0n;
    let taxTotal = 0n;
    let grandTotal = 0n;
    // P1F-2 in-scope micro-fix: COGS is unitCostSnapshot x quantity, not the
    // bare per-unit snapshot — a qty=3 line must contribute 3x, not 1x. Exact
    // rational arithmetic, ONE HALF_UP rounding per line (BR-FIN-001).
    let cogsExact: Rational | null = null;
    for (const line of lines) {
      subtotal += line.lineSubtotal;
      taxTotal += line.taxAmount;
      grandTotal += line.lineTotal;
      if (line.unitCostSnapshot !== null) {
        const lineCogs = multiply(
          rational(line.unitCostSnapshot),
          fromExactDecimal(parseExactDecimal(line.quantity.toFixed(3))),
        );
        cogsExact = cogsExact ? add(cogsExact, lineCogs) : lineCogs;
      }
    }
    const cogs = cogsExact
      ? toMinorUnits(cogsExact, RoundingMode.HALF_UP)
      : null;
    // Named only to make the currency explicit at the boundary; the arithmetic
    // above is already exact bigint minor units.
    void Money.of(grandTotal, currency);

    // NOTE: `discountTotal`, `serviceChargeTotal` and `roundingAdjustment` are
    // NOT recomputed here — discounts (BR-FIN-003), service charge and cash
    // rounding (BR-FIN-004) are not implemented, so this slice must not pretend
    // to maintain them. They stay at their defaults of 0.
    return { subtotal, taxTotal, grandTotal, cogsTotal: cogs };
  }
}
