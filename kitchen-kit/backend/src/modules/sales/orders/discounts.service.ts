/**
 * POS-FIN-1 — Discounts and Comps (FR-POS-045/046/047/049/050).
 *
 * Line-level and order-level, percentage and fixed, exactly FR-POS-045's
 * two dimensions. A comp (FR-POS-050) is implemented as the SAME
 * line-discount mechanics with the discount set to the line's full base —
 * revenue goes to zero automatically because `lineTotal` is re-derived from
 * `lineSubtotal - lineDiscount` the identical way an ordinary discount is,
 * and COGS/inventory depletion are UNAFFECTED because a comped line's own
 * `state` never changes (still `pending`/`fired`/.../`served`) — only
 * `isComp` and `lineDiscount` do. This is what makes FR-POS-050's "cost is
 * still recognised and inventory is still depleted" true with no special
 * casing anywhere else: `recomputeOrderTotals`'s COGS sum and
 * `SalesPaymentService.completeSettling`'s depletion-plan query both key
 * off `state`, never `isComp`/`lineDiscount`.
 *
 * ── NO STACKING (FR-POS-051 narrowing, design gate §7 item 3) ────────────
 * At most ONE discount/comp per line, and at most ONE order-level discount
 * per order. No `Promotion`/exclusivity model exists anywhere in this
 * schema; a genuine multi-promotion engine is out of scope and this is
 * recorded as such rather than silently approximated.
 *
 * ── APPROVAL THRESHOLD STORAGE — A NARROW, EXPLICITLY-SCOPED MVP ─────────
 * See `DiscountApprovalPolicyVersion`'s own doc comment (schema.prisma):
 * scoped to (tenant, branch), not per-role — no ratified role-precedence
 * rule exists. Absent any configured policy, EVERY discount requires
 * approval (the conservative default — never silently permissive).
 * `pos.discount.unlimited` is the one per-actor override this MVP
 * implements.
 *
 * ── TAX SEMANTICS ─────────────────────────────────────────────────────────
 * Line-level discount reduces the line's TAXABLE BASE (pre-tax application)
 * — `computeTaxableBase`'s own pre-existing `lineDiscount` parameter is the
 * source-decidable evidence for this (design gate §7 item 8, resolved: it
 * already exists specifically to subtract a line discount before tax).
 * Order-level discount does NOT reduce any line's taxable base or tax
 * amount — apportioning an order-level discount across lines for tax
 * purposes is BR-FIN-003, which `order-lines.service.ts`'s own pre-existing
 * comment states is "NOT implemented" in this codebase; this slice does not
 * silently invent it. An order-level discount is therefore applied POST-TAX,
 * as a straight subtraction from `grandTotal` only (`recomputeOrderTotals`).
 * This is a recorded scoping decision, not an oversight.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Money } from '../../../common/money/money';
import {
  computeTaxableBase,
  computeLineTax,
} from '../../localisation/tax/tax.calculator';
import type { LineTaxResult } from '../../localisation/tax/tax.model';
import { CountryPackService } from '../../localisation/country-pack/country-pack.service';
import { TaxEngineRegistry } from '../../localisation/tax/tax-engine.registry';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { APPROVAL_COMMANDS } from '../../governance/contract';
import type { ApprovalCommands } from '../../governance/contract';
import { SCOPE_AUTHORIZATION } from '../../identity/contract';
import type {
  ScopeAuthorizationActor,
  ScopeAuthorizationPort,
  VerifiedTerminalPrincipal,
} from '../../identity/contract';
import { SALES_PERMISSIONS } from '../sales.permissions';
import {
  OrderVersionConflictError,
  assertMayApplyDiscount,
  assertVersion,
} from './order-state';
import { recomputeOrderTotals } from './order-totals';
import { obtainSynchronousApproval } from './approval-helper';
import { Prisma } from '../../../generated/prisma/client';

export interface ManagerApprovalInput {
  readonly approvalRequestId: string;
  readonly approvalDecisionId: string;
  readonly approver: VerifiedTerminalPrincipal;
}

export interface ApplyLineDiscountInput {
  readonly id?: string;
  readonly expectedVersion: number;
  readonly type: 'percentage' | 'fixed';
  /** percentage: exact decimal string, 2dp max, `0 < value <= 100`. fixed: minor-units integer string. */
  readonly value: string;
  readonly reasonCodeId: string;
  readonly employeeId: string;
  readonly auth: ScopeAuthorizationActor;
  readonly manager?: ManagerApprovalInput;
}

export interface ApplyOrderDiscountInput {
  readonly id?: string;
  readonly expectedVersion: number;
  readonly type: 'percentage' | 'fixed';
  readonly value: string;
  readonly reasonCodeId: string;
  readonly employeeId: string;
  readonly auth: ScopeAuthorizationActor;
  readonly manager?: ManagerApprovalInput;
}

export interface ApplyCompInput {
  readonly id?: string;
  readonly expectedVersion: number;
  readonly reasonCodeId: string;
  readonly employeeId: string;
}

const MAX_PERCENT_BP = 10000n;

@Injectable()
export class DiscountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly countryPacks: CountryPackService,
    private readonly taxEngines: TaxEngineRegistry,
    @Inject(APPROVAL_COMMANDS) private readonly approvals: ApprovalCommands,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
  ) {}

  // ============================================================ LINE ====

  async applyLineDiscount(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    lineId: string,
    input: ApplyLineDiscountInput,
  ) {
    const { percentageValueBp, fixedValueMinor } = parseDiscountValue(
      input.type,
      input.value,
    );
    const discountId = input.id ?? newId();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await this.loadOrder(tx, orderId, businessDay);
        const line = await tx.orderLine.findUnique({
          where: { id_businessDay: { id: lineId, businessDay } },
          select: {
            id: true,
            orderId: true,
            state: true,
            lineSubtotal: true,
            lineDiscount: true,
            isComp: true,
            taxClassId: true,
          },
        });
        if (!line || line.orderId !== order.id) {
          throw new NotFoundException('Order line not found.');
        }
        if (line.lineDiscount > 0n || line.isComp) {
          throw new ConflictException(
            'This line already carries a discount or comp — stacking is ' +
              'not supported (FR-POS-051 out of scope for this release).',
          );
        }

        assertMayApplyDiscount(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);
        await this.assertDiscountAfterPaymentAllowed(tx, tenantId, order);

        const reason = await this.requireReasonCode(tx, input.reasonCodeId);

        const base = line.lineSubtotal;
        const amountMinor = computeDiscountAmount(
          base,
          input.type,
          percentageValueBp,
          fixedValueMinor,
        );

        const unlimited = await this.scopeAuthorization.isAuthorized(
          input.auth,
          { codes: [SALES_PERMISSIONS.DISCOUNT_UNLIMITED], mode: 'all' },
          { type: 'branch', branchId: order.branchId },
          tx,
        );
        const approvalRequired = unlimited
          ? false
          : await this.evaluateApprovalRequired(
              tx,
              tenantId,
              order.branchId,
              input.employeeId,
              { percentageValueBp, fixedValueMinor },
            );

        const approverId = await this.resolveApproval(
          tx,
          tenantId,
          actorUserId,
          order,
          input.employeeId,
          approvalRequired,
          discountId,
          input.manager,
          {
            scope: 'line',
            orderLineId: line.id,
            amountMinor,
            type: input.type,
            percentageValueBp,
            fixedValueMinor,
          },
        );

        // ── Recompute the line's tax with the new taxable base. ──────────
        const { newTaxAmount, newLineTotal, pack } =
          await this.recomputeLineTax(tx, order, line, amountMinor);

        const updatedLine = await tx.orderLine.update({
          where: { id_businessDay: { id: lineId, businessDay } },
          data: {
            lineDiscount: amountMinor,
            taxAmount: newTaxAmount,
            lineTotal: newLineTotal,
          },
        });

        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
        );
        // CAS on `version` — never a plain PK update. Two concurrent
        // discount attempts on the same order must not both silently apply
        // against a stale total (task instruction: "no race where two
        // concurrent discounts independently pass the same threshold
        // against stale order totals"); the loser gets a real 409, matching
        // `SalesPaymentService.capture`'s own pattern.
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: { ...totals, version: nextVersion, updatedAt: new Date() },
        });
        if (updateResult.count === 0) {
          throw new OrderVersionConflictError(
            `Version mismatch: the order changed concurrently and is no ` +
              `longer at version ${input.expectedVersion}. Reload the order and retry.`,
          );
        }
        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id_businessDay: { id: order.id, businessDay } },
        });

        const createdDiscount = await tx.discount.create({
          data: {
            id: discountId,
            tenantId,
            branchId: order.branchId,
            orderId: order.id,
            businessDay,
            orderLineId: line.id,
            kind: 'discount',
            valueType: input.type,
            percentageValueBp:
              input.type === 'percentage' ? percentageValueBp : null,
            fixedValueMinor: input.type === 'fixed' ? fixedValueMinor : null,
            amountMinor,
            reasonCodeId: reason.id,
            appliedByEmployeeId: input.employeeId,
            appliedByUserId: actorUserId,
            approvalRequired,
            ...(approverId
              ? {
                  approvedByUserId: approverId.userId,
                  approvedByEmployeeId: approverId.employeeId,
                }
              : {}),
            ...(approverId
              ? { approvalRequestId: input.manager!.approvalRequestId }
              : {}),
            orderVersionAfter: nextVersion,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.DISCOUNT_APPLIED,
          entityType: AUDIT_ENTITY.DISCOUNT,
          actorType: 'user',
          actorId: actorUserId,
          entityId: discountId,
          terminalId: order.terminalId,
          ...(approverId
            ? {
                approverId: approverId.userId,
                approvalId: input.manager!.approvalRequestId,
              }
            : {}),
          reasonCode: reason.id,
          before: {
            lineDiscount: line.lineDiscount.toString(),
            lineTotal: line.lineSubtotal.toString(),
          },
          metadata: {
            orderId: order.id,
            orderLineId: line.id,
            scope: 'line',
            type: input.type,
            percentageValueBp: percentageValueBp?.toString() ?? null,
            fixedValueMinor: fixedValueMinor?.toString() ?? null,
            amountMinor: amountMinor.toString(),
            appliedByEmployeeId: input.employeeId,
            approvalRequired,
            orderVersion: nextVersion,
            countryPack: `${pack.code}-${pack.version}`,
          },
        });

        return {
          line: updatedLine,
          order: updatedOrder,
          discount: createdDiscount,
        };
      },
    );
  }

  // =========================================================== ORDER ====

  async applyOrderDiscount(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    input: ApplyOrderDiscountInput,
  ) {
    const { percentageValueBp, fixedValueMinor } = parseDiscountValue(
      input.type,
      input.value,
    );
    const discountId = input.id ?? newId();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await this.loadOrder(tx, orderId, businessDay);

        const existingOrderLevel = await tx.discount.findFirst({
          where: {
            tenantId,
            orderId: order.id,
            businessDay,
            orderLineId: null,
          },
          select: { id: true },
        });
        if (existingOrderLevel) {
          throw new ConflictException(
            'This order already carries an order-level discount — stacking ' +
              'is not supported (FR-POS-051 out of scope for this release).',
          );
        }

        assertMayApplyDiscount(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);
        await this.assertDiscountAfterPaymentAllowed(tx, tenantId, order);

        const reason = await this.requireReasonCode(tx, input.reasonCodeId);

        const base = order.grandTotal;
        const amountMinor = computeDiscountAmount(
          base,
          input.type,
          percentageValueBp,
          fixedValueMinor,
        );

        const unlimited = await this.scopeAuthorization.isAuthorized(
          input.auth,
          { codes: [SALES_PERMISSIONS.DISCOUNT_UNLIMITED], mode: 'all' },
          { type: 'branch', branchId: order.branchId },
          tx,
        );
        const approvalRequired = unlimited
          ? false
          : await this.evaluateApprovalRequired(
              tx,
              tenantId,
              order.branchId,
              input.employeeId,
              { percentageValueBp, fixedValueMinor },
            );

        const approverId = await this.resolveApproval(
          tx,
          tenantId,
          actorUserId,
          order,
          input.employeeId,
          approvalRequired,
          discountId,
          input.manager,
          {
            scope: 'order',
            amountMinor,
            type: input.type,
            percentageValueBp,
            fixedValueMinor,
          },
        );

        const createdDiscount = await tx.discount.create({
          data: {
            id: discountId,
            tenantId,
            branchId: order.branchId,
            orderId: order.id,
            businessDay,
            orderLineId: null,
            kind: 'discount',
            valueType: input.type,
            percentageValueBp:
              input.type === 'percentage' ? percentageValueBp : null,
            fixedValueMinor: input.type === 'fixed' ? fixedValueMinor : null,
            amountMinor,
            reasonCodeId: reason.id,
            appliedByEmployeeId: input.employeeId,
            appliedByUserId: actorUserId,
            approvalRequired,
            ...(approverId
              ? {
                  approvedByUserId: approverId.userId,
                  approvedByEmployeeId: approverId.employeeId,
                }
              : {}),
            ...(approverId
              ? { approvalRequestId: input.manager!.approvalRequestId }
              : {}),
            orderVersionAfter: nextVersion,
          },
        });

        // Recompute AFTER the Discount row exists — `recomputeOrderTotals`
        // reads the order-level discount fresh from that same table.
        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
        );
        // CAS on `version` — never a plain PK update. Two concurrent
        // discount attempts on the same order must not both silently apply
        // against a stale total (task instruction: "no race where two
        // concurrent discounts independently pass the same threshold
        // against stale order totals"); the loser gets a real 409, matching
        // `SalesPaymentService.capture`'s own pattern.
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: { ...totals, version: nextVersion, updatedAt: new Date() },
        });
        if (updateResult.count === 0) {
          throw new OrderVersionConflictError(
            `Version mismatch: the order changed concurrently and is no ` +
              `longer at version ${input.expectedVersion}. Reload the order and retry.`,
          );
        }
        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id_businessDay: { id: order.id, businessDay } },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.DISCOUNT_APPLIED,
          entityType: AUDIT_ENTITY.DISCOUNT,
          actorType: 'user',
          actorId: actorUserId,
          entityId: discountId,
          terminalId: order.terminalId,
          ...(approverId
            ? {
                approverId: approverId.userId,
                approvalId: input.manager!.approvalRequestId,
              }
            : {}),
          reasonCode: reason.id,
          before: { grandTotal: order.grandTotal.toString() },
          metadata: {
            orderId: order.id,
            scope: 'order',
            type: input.type,
            percentageValueBp: percentageValueBp?.toString() ?? null,
            fixedValueMinor: fixedValueMinor?.toString() ?? null,
            amountMinor: amountMinor.toString(),
            appliedByEmployeeId: input.employeeId,
            approvalRequired,
            orderVersion: nextVersion,
          },
        });

        return { order: updatedOrder, discount: createdDiscount };
      },
    );
  }

  // ============================================================= COMP ====

  /**
   * FR-POS-050. No approval-threshold evaluation: FR-POS-047's four
   * dimensions are literally scoped to "discounts"; FR-POS-050 does not
   * cross-reference them. `pos.comp.apply` (checked at the controller) is
   * the sole gate — a recorded, source-decidable scoping choice.
   */
  async applyComp(
    tenantId: string,
    actorUserId: string,
    orderId: string,
    businessDay: Date,
    lineId: string,
    input: ApplyCompInput,
  ) {
    const discountId = input.id ?? newId();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const order = await this.loadOrder(tx, orderId, businessDay);
        const line = await tx.orderLine.findUnique({
          where: { id_businessDay: { id: lineId, businessDay } },
          select: {
            id: true,
            orderId: true,
            state: true,
            lineSubtotal: true,
            lineDiscount: true,
            isComp: true,
            taxClassId: true,
          },
        });
        if (!line || line.orderId !== order.id) {
          throw new NotFoundException('Order line not found.');
        }
        if (line.lineDiscount > 0n || line.isComp) {
          throw new ConflictException(
            'This line already carries a discount or comp.',
          );
        }

        assertMayApplyDiscount(order.state);
        const nextVersion = assertVersion(order.version, input.expectedVersion);

        const reason = await this.requireReasonCode(tx, input.reasonCodeId);

        // The comp value IS the line's full base — revenue goes to zero.
        const amountMinor = line.lineSubtotal;

        const { newTaxAmount, newLineTotal, pack } =
          await this.recomputeLineTax(tx, order, line, amountMinor);

        const updatedLine = await tx.orderLine.update({
          where: { id_businessDay: { id: lineId, businessDay } },
          data: {
            lineDiscount: amountMinor,
            isComp: true,
            taxAmount: newTaxAmount,
            lineTotal: newLineTotal,
          },
        });

        const totals = await recomputeOrderTotals(
          tx,
          tenantId,
          order.id,
          businessDay,
          order.currency,
        );
        // CAS on `version` — never a plain PK update. Two concurrent
        // discount attempts on the same order must not both silently apply
        // against a stale total (task instruction: "no race where two
        // concurrent discounts independently pass the same threshold
        // against stale order totals"); the loser gets a real 409, matching
        // `SalesPaymentService.capture`'s own pattern.
        const updateResult = await tx.order.updateMany({
          where: { id: order.id, businessDay, version: input.expectedVersion },
          data: { ...totals, version: nextVersion, updatedAt: new Date() },
        });
        if (updateResult.count === 0) {
          throw new OrderVersionConflictError(
            `Version mismatch: the order changed concurrently and is no ` +
              `longer at version ${input.expectedVersion}. Reload the order and retry.`,
          );
        }
        const updatedOrder = await tx.order.findUniqueOrThrow({
          where: { id_businessDay: { id: order.id, businessDay } },
        });

        const createdDiscount = await tx.discount.create({
          data: {
            id: discountId,
            tenantId,
            branchId: order.branchId,
            orderId: order.id,
            businessDay,
            orderLineId: line.id,
            kind: 'comp',
            valueType: null,
            percentageValueBp: null,
            fixedValueMinor: null,
            amountMinor,
            reasonCodeId: reason.id,
            appliedByEmployeeId: input.employeeId,
            appliedByUserId: actorUserId,
            approvalRequired: false,
            orderVersionAfter: nextVersion,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.COMP_APPLIED,
          entityType: AUDIT_ENTITY.DISCOUNT,
          actorType: 'user',
          actorId: actorUserId,
          entityId: discountId,
          terminalId: order.terminalId,
          reasonCode: reason.id,
          before: {
            lineDiscount: line.lineDiscount.toString(),
            lineTotal: line.lineSubtotal.toString(),
          },
          metadata: {
            orderId: order.id,
            orderLineId: line.id,
            amountMinor: amountMinor.toString(),
            appliedByEmployeeId: input.employeeId,
            orderVersion: nextVersion,
            countryPack: `${pack.code}-${pack.version}`,
          },
        });

        return {
          line: updatedLine,
          order: updatedOrder,
          discount: createdDiscount,
        };
      },
    );
  }

  // ------------------------------------------------------------- internals

  private async loadOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    businessDay: Date,
  ) {
    const order = await tx.order.findUnique({
      where: { id_businessDay: { id: orderId, businessDay } },
      select: {
        id: true,
        businessDay: true,
        branchId: true,
        terminalId: true,
        state: true,
        version: true,
        currency: true,
        countryPackVersion: true,
        orderType: true,
        grandTotal: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found.');
    return order;
  }

  private async requireReasonCode(
    tx: Prisma.TransactionClient,
    reasonCodeId: string,
  ) {
    const reason = await tx.reasonCode.findUnique({
      where: { id: reasonCodeId },
      select: { id: true },
    });
    if (!reason) {
      throw new UnprocessableEntityException(
        'A discount requires a reason code that exists in this tenant (FR-POS-046).',
      );
    }
    return reason;
  }

  private async assertDiscountAfterPaymentAllowed(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: { state: string; branchId: string },
  ): Promise<void> {
    if (order.state !== 'partially_paid') return;
    const policy = await this.resolvePolicy(tx, tenantId, order.branchId);
    if (!policy || !policy.discountAfterPaymentStartedAllowed) {
      throw new UnprocessableEntityException(
        'Discounts are not permitted once payment has started for this ' +
          'branch (FR-POS-047 dimension 4).',
      );
    }
  }

  private async resolvePolicy(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ) {
    return tx.discountApprovalPolicyVersion.findFirst({
      where: { tenantId, branchId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * FR-POS-047 dimensions 1-3 (dimension 4, "after payment started", is
   * checked separately by `assertDiscountAfterPaymentAllowed` — it BLOCKS
   * rather than requires approval). No policy configured = the conservative
   * default: approval is ALWAYS required.
   */
  private async evaluateApprovalRequired(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    employeeId: string,
    discount: {
      percentageValueBp: bigint | null;
      fixedValueMinor: bigint | null;
    },
  ): Promise<boolean> {
    const policy = await this.resolvePolicy(tx, tenantId, branchId);
    if (!policy) return true;

    if (discount.percentageValueBp !== null) {
      if (
        policy.maxPercentWithoutApprovalBp === null ||
        discount.percentageValueBp > policy.maxPercentWithoutApprovalBp
      ) {
        return true;
      }
    }
    if (discount.fixedValueMinor !== null) {
      if (
        policy.maxAmountWithoutApprovalMinor === null ||
        discount.fixedValueMinor > policy.maxAmountWithoutApprovalMinor
      ) {
        return true;
      }
    }
    if (policy.maxDiscountsPerShiftPerEmployee !== null) {
      const shift = await tx.shift.findFirst({
        where: { tenantId, branchId, employeeId, status: 'open' },
        select: { id: true, openedAt: true },
      });
      if (shift) {
        const countThisShift = await tx.discount.count({
          where: {
            tenantId,
            branchId,
            appliedByEmployeeId: employeeId,
            createdAt: { gte: shift.openedAt },
          },
        });
        if (countThisShift >= policy.maxDiscountsPerShiftPerEmployee) {
          return true;
        }
      }
    }
    return false;
  }

  private async resolveApproval(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
    order: { id: string; businessDay: Date; branchId: string },
    employeeId: string,
    approvalRequired: boolean,
    discountId: string,
    manager: ManagerApprovalInput | undefined,
    value: Record<string, unknown>,
  ): Promise<{ userId: string; employeeId: string } | null> {
    if (!approvalRequired) return null;
    if (!manager) {
      throw new ForbiddenException(
        'This discount is above the configured threshold and requires ' +
          'manager approval (FR-POS-047). Supply a manager PIN and retry.',
      );
    }
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    const jsonValue: Prisma.InputJsonValue = {
      orderId: order.id,
      ...value,
      amountMinor: (value.amountMinor as bigint).toString(),
      percentageValueBp: value.percentageValueBp
        ? (value.percentageValueBp as bigint).toString()
        : null,
      fixedValueMinor: value.fixedValueMinor
        ? (value.fixedValueMinor as bigint).toString()
        : null,
    };
    await obtainSynchronousApproval(this.approvals, {
      tx,
      tenantId,
      requestedByUserId: actorUserId,
      requestType: 'discount.apply',
      entityType: AUDIT_ENTITY.DISCOUNT,
      entityId: discountId,
      value: jsonValue,
      requiredPermission: SALES_PERMISSIONS.DISCOUNT_APPROVE,
      ...(employee?.userId ? { excludedApproverUserId: employee.userId } : {}),
      approvalRequestId: manager.approvalRequestId,
      approvalDecisionId: manager.approvalDecisionId,
      approver: manager.approver,
    });
    return {
      userId: manager.approver.userId,
      employeeId: manager.approver.employeeId,
    };
  }

  private async recomputeLineTax(
    tx: Prisma.TransactionClient,
    order: {
      branchId: string;
      countryPackVersion: string;
      currency: string;
      orderType: string;
    },
    line: { lineSubtotal: bigint; taxClassId: string },
    discountAmountMinor: bigint,
  ): Promise<{
    newTaxAmount: bigint;
    newLineTotal: bigint;
    pack: { code: string; version: string };
  }> {
    const branch = await tx.branch.findUnique({
      where: { id: order.branchId },
      select: { countryCode: true },
    });
    if (!branch) throw new NotFoundException('Branch not found.');
    const pack = this.countryPacks.requirePinned(
      branch.countryCode,
      order.countryPackVersion,
    );
    const taxClass = await tx.taxClass.findUnique({
      where: { id: line.taxClassId },
      select: { code: true },
    });
    if (!taxClass) {
      throw new UnprocessableEntityException(
        'This line has no resolvable tax class.',
      );
    }

    const taxableBase = computeTaxableBase({
      unitPrice: Money.of(line.lineSubtotal, order.currency),
      quantity: '1',
      lineDiscount: Money.of(discountAmountMinor, order.currency),
    });
    let lineTax: LineTaxResult;
    try {
      lineTax = computeLineTax(pack, this.taxEngines, {
        taxableBase,
        taxClassCode: taxClass.code,
        orderType: order.orderType,
      });
    } catch (error) {
      throw new UnprocessableEntityException((error as Error).message);
    }
    const newLineSubtotalNet = line.lineSubtotal - discountAmountMinor;
    const newLineTotal =
      pack.tax.pricingMode === 'tax_inclusive'
        ? newLineSubtotalNet
        : newLineSubtotalNet + lineTax.taxAmount.amount;
    return {
      newTaxAmount: lineTax.taxAmount.amount,
      newLineTotal,
      pack: { code: pack.code, version: pack.version },
    };
  }
}

// ------------------------------------------------------------------ pure ==

function parseDiscountValue(
  type: 'percentage' | 'fixed',
  value: string,
): { percentageValueBp: bigint | null; fixedValueMinor: bigint | null } {
  if (type === 'percentage') {
    const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) {
      throw new BadRequestException(
        'A percentage discount value must be a decimal with at most 2 decimal places.',
      );
    }
    const whole = BigInt(match[1]);
    const frac = (match[2] ?? '').padEnd(2, '0');
    const bp = whole * 100n + BigInt(frac || '0');
    if (bp <= 0n || bp > MAX_PERCENT_BP) {
      throw new UnprocessableEntityException(
        'A percentage discount must be greater than 0 and at most 100.',
      );
    }
    return { percentageValueBp: bp, fixedValueMinor: null };
  }
  if (!/^\d{1,18}$/.test(value)) {
    throw new BadRequestException(
      'A fixed discount value must be a whole number of minor units expressed as a string.',
    );
  }
  const minor = BigInt(value);
  if (minor <= 0n) {
    throw new UnprocessableEntityException(
      'A fixed discount must be greater than zero.',
    );
  }
  return { percentageValueBp: null, fixedValueMinor: minor };
}

function computeDiscountAmount(
  baseMinor: bigint,
  type: 'percentage' | 'fixed',
  percentageValueBp: bigint | null,
  fixedValueMinor: bigint | null,
): bigint {
  if (baseMinor <= 0n) {
    throw new UnprocessableEntityException(
      'Cannot apply a discount to a zero or negative base.',
    );
  }
  if (type === 'percentage') {
    const bp = percentageValueBp!;
    // Exact bigint percentage math (BR-FIN-001: one rounding, HALF_UP):
    // amount = round((base * bp) / 10000).
    const numerator = baseMinor * bp;
    const denominator = 10000n;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
    if (rounded > baseMinor) {
      throw new UnprocessableEntityException(
        'A discount cannot exceed its eligible base.',
      );
    }
    return rounded;
  }
  const fixed = fixedValueMinor!;
  if (fixed > baseMinor) {
    throw new UnprocessableEntityException(
      'A fixed discount cannot exceed its eligible base (BR — no negative line/order).',
    );
  }
  return fixed;
}
