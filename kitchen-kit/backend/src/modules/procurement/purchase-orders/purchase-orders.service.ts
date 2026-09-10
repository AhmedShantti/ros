import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import { CurrencyError, currencyOf } from '../../../common/money/currency';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  APPROVAL_COMMANDS,
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
  type ApprovalCommands,
} from '../../governance/contract';
import {
  EFFECTIVE_SETTING_QUERY,
  type EffectiveSettingQuery,
} from '../../platform-settings/contract';
import {
  PROCUREMENT_FACTS_QUERY,
  PURCHASE_ORDER_APPROVED_EVENT_TYPE,
  PURCHASE_ORDER_APPROVED_EVENT_VERSION,
  type ProcurementFactsQuery,
  type PurchaseOrderApprovedPayload,
} from '../contract';
import { PROCUREMENT_PERMISSIONS } from '../procurement.permissions';
import type {
  CreatePurchaseOrderDto,
  SubmitPurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from '../procurement.dto';
import {
  PurchaseOrderLineBuilder,
  type BuiltPurchaseOrderLine,
} from './purchase-order-line-builder.service';
import { computeHeaderTotals } from './po-totals';
import { assertPoVersion } from './po-state';
import {
  PO_APPROVAL_THRESHOLDS_SETTING_KEY,
  parsePoApprovalThresholds,
  requireConfiguredThresholds,
  requiredPermissionForBand,
  resolveApprovalBand,
} from './po-thresholds';

/** FR-PRC-018 §7 D-10: "mandatory, no default duration exists — the caller
 *  must supply it." No ratified value exists for THIS domain's expiry (the
 *  2-minute synchronous-decision window `approval-helper.ts` uses is for a
 *  same-transaction discount/refund flow; PO approval is genuinely
 *  asynchronous — the approving manager arrives separately, at a terminal,
 *  to decide). Seven days is a recorded engineering judgment call, not a
 *  source-given value. */
const PO_APPROVAL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly lineBuilder: PurchaseOrderLineBuilder,
    @Inject(PROCUREMENT_FACTS_QUERY)
    private readonly procurementFacts: ProcurementFactsQuery,
    @Inject(EFFECTIVE_SETTING_QUERY)
    private readonly effectiveSetting: EffectiveSettingQuery,
    @Inject(APPROVAL_COMMANDS)
    private readonly approvals: ApprovalCommands,
  ) {}

  private assertCurrency(code: string): void {
    try {
      currencyOf(code);
    } catch (err) {
      if (err instanceof CurrencyError)
        throw new BadRequestException(err.message);
      throw err;
    }
  }

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreatePurchaseOrderDto,
  ) {
    this.assertCurrency(dto.currency);
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const supplier = await this.procurementFacts.getSupplierFacts(tx, {
          tenantId,
          supplierId: dto.supplierId,
        });
        if (!supplier) {
          throw new NotFoundException(`Supplier ${dto.supplierId} not found.`);
        }
        if (supplier.status !== 'active') {
          throw new UnprocessableEntityException(
            `Supplier ${dto.supplierId} is not active.`,
          );
        }

        await this.lineBuilder.resolveDeliveryLocation(
          tx,
          tenantId,
          dto.deliveryLocationType,
          dto.deliveryLocationId,
        );

        const builtLines: BuiltPurchaseOrderLine[] = [];
        for (const line of dto.lines ?? []) {
          builtLines.push(
            await this.lineBuilder.buildLine(
              tx,
              tenantId,
              dto.supplierId,
              dto.currency,
              line,
            ),
          );
        }
        const headerTotals = computeHeaderTotals(builtLines);

        const poId = newId();
        // A nested `lines: { create: [...] } }` here hits a genuine Prisma
        // 7 checked/unchecked nested-write ambiguity ("Unknown argument
        // tenantId") because `PurchaseOrderLine` declares explicit relations
        // (`tenant`, `supplierPriceEntry`, `sourceRequisitionLine`) alongside
        // their scalar FK columns — the same reason `update()`/`amend()`
        // already insert lines via a SEPARATE `createMany` instead of a
        // nested write. Mirrored here for consistency and correctness.
        await tx.purchaseOrder.create({
          data: {
            id: poId,
            tenantId,
            supplierId: dto.supplierId,
            deliveryLocationType: dto.deliveryLocationType,
            deliveryLocationId: dto.deliveryLocationId,
            expectedDeliveryDate: new Date(dto.expectedDeliveryDate),
            currency: dto.currency,
            status: 'draft',
            requestedBy: actorUserId,
            subtotal: headerTotals.subtotalMinor,
            taxTotal: headerTotals.taxTotalMinor,
            grandTotal: headerTotals.grandTotalMinor,
            version: 1,
          },
        });
        if (builtLines.length > 0) {
          await tx.purchaseOrderLine.createMany({
            data: builtLines.map((l) =>
              this.lineBuilder.toPrismaLineCreateManyInput(tenantId, poId, l),
            ),
          });
        }
        const po = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: poId },
          include: { lines: true },
        });

        const touchedRequisitionIds = new Set<string>();
        for (const line of builtLines) {
          if (line.sourceRequisitionLineId) {
            const reqLine = await tx.purchaseRequisitionLine.findUnique({
              where: { id: line.sourceRequisitionLineId },
              select: { requisitionId: true },
            });
            if (reqLine) touchedRequisitionIds.add(reqLine.requisitionId);
          }
        }
        await this.lineBuilder.markRequisitionsConvertedIfComplete(
          tx,
          tenantId,
          touchedRequisitionIds,
        );

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_ORDER_CREATED,
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: po.id,
          metadata: {
            supplierId: po.supplierId,
            lineCount: po.lines.length,
            grandTotal: po.grandTotal.toString(),
          },
        });

        return po;
      },
    );
  }

  async findAll(
    tenantId: string,
    actorUserId: string,
    filter: { status?: string; supplierId?: string },
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      (tx) =>
        tx.purchaseOrder.findMany({
          where: {
            status: filter.status as never,
            supplierId: filter.supplierId,
          },
          include: { lines: true },
          orderBy: { createdAt: 'desc' },
        }),
    );
  }

  async findById(tenantId: string, actorUserId: string, id: string) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      (tx) =>
        tx.purchaseOrder.findUnique({
          where: { id },
          include: { lines: true },
        }),
    );
  }

  async listAmendments(tenantId: string, actorUserId: string, id: string) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      (tx) =>
        tx.purchaseOrderAmendment.findMany({
          where: { purchaseOrderId: id },
          orderBy: { amendmentNumber: 'asc' },
        }),
    );
  }

  /** §6 — only a `draft` PO may have ordinary line edits before submission. */
  async update(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const po = await tx.purchaseOrder.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!po) throw new NotFoundException('Purchase order not found.');
        if (po.status !== 'draft') {
          throw new UnprocessableEntityException(
            `Purchase order ${id} is '${po.status}', not 'draft' — only a ` +
              'draft purchase order may have ordinary line edits.',
          );
        }
        const nextVersion = assertPoVersion(po.version, dto.expectedVersion);

        const deliveryLocationType =
          dto.deliveryLocationType ?? po.deliveryLocationType;
        const deliveryLocationId =
          dto.deliveryLocationId ?? po.deliveryLocationId;
        if (dto.deliveryLocationType || dto.deliveryLocationId) {
          await this.lineBuilder.resolveDeliveryLocation(
            tx,
            tenantId,
            deliveryLocationType,
            deliveryLocationId,
          );
        }

        let headerTotals = {
          subtotalMinor: po.subtotal,
          taxTotalMinor: po.taxTotal,
          grandTotalMinor: po.grandTotal,
        };
        const touchedRequisitionIds = new Set<string>();
        if (dto.lines) {
          // Freed: any requisition line previously consumed by a line this
          // replacement removes becomes consolidatable again (recorded
          // limitation: a requisition already `converted` is not reverted —
          // see this module's own report).
          await tx.purchaseOrderLine.deleteMany({
            where: { purchaseOrderId: id },
          });
          const built: BuiltPurchaseOrderLine[] = [];
          for (const line of dto.lines) {
            built.push(
              await this.lineBuilder.buildLine(
                tx,
                tenantId,
                po.supplierId,
                po.currency,
                line,
              ),
            );
          }
          headerTotals = computeHeaderTotals(built);
          await tx.purchaseOrderLine.createMany({
            data: built.map((l) =>
              this.lineBuilder.toPrismaLineCreateManyInput(tenantId, id, l),
            ),
          });
          for (const line of built) {
            if (line.sourceRequisitionLineId) {
              const reqLine = await tx.purchaseRequisitionLine.findUnique({
                where: { id: line.sourceRequisitionLineId },
                select: { requisitionId: true },
              });
              if (reqLine) touchedRequisitionIds.add(reqLine.requisitionId);
            }
          }
        }
        await this.lineBuilder.markRequisitionsConvertedIfComplete(
          tx,
          tenantId,
          touchedRequisitionIds,
        );

        const updateResult = await tx.purchaseOrder.updateMany({
          where: { id, version: dto.expectedVersion },
          data: {
            deliveryLocationType,
            deliveryLocationId,
            expectedDeliveryDate: dto.expectedDeliveryDate
              ? new Date(dto.expectedDeliveryDate)
              : po.expectedDeliveryDate,
            subtotal: headerTotals.subtotalMinor,
            taxTotal: headerTotals.taxTotalMinor,
            grandTotal: headerTotals.grandTotalMinor,
            version: nextVersion,
            updatedAt: new Date(),
          },
        });
        if (updateResult.count === 0) {
          throw new ConflictException(
            'Version mismatch: the purchase order changed concurrently.',
          );
        }

        const updated = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id },
          include: { lines: true },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_ORDER_UPDATED,
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: id,
          before: { grandTotal: po.grandTotal.toString(), version: po.version },
          metadata: {
            grandTotal: updated.grandTotal.toString(),
            version: updated.version,
          },
        });

        return updated;
      },
    );
  }

  /** FR-PRC-018/019 §7-9 — evaluate the value band, snapshot it, and either
   *  auto-approve (below threshold 1, no human approver, mission brief §8)
   *  or create a manual Governance ApprovalRequest. */
  async submit(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: SubmitPurchaseOrderDto,
  ) {
    return this.unitOfWork.execute(
      { userId: actorUserId, tenantId },
      async (ctx) => {
        const tx = ctx.tx;
        const po = await tx.purchaseOrder.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!po) throw new NotFoundException('Purchase order not found.');
        if (po.status !== 'draft') {
          throw new UnprocessableEntityException(
            `Purchase order ${id} is '${po.status}', not 'draft'.`,
          );
        }
        if (po.lines.length === 0) {
          throw new UnprocessableEntityException(
            'A submitted purchase order must have at least one line.',
          );
        }
        const nextVersion = assertPoVersion(po.version, dto.expectedVersion);

        const settingValue = await this.effectiveSetting.getEffectiveSetting(
          tx,
          tenantId,
          { settingKey: PO_APPROVAL_THRESHOLDS_SETTING_KEY },
        );
        requireConfiguredThresholds(settingValue.hasEffectiveValue);
        const thresholds = parsePoApprovalThresholds(
          settingValue.effectiveValue,
        );
        const band = resolveApprovalBand(po.grandTotal, thresholds);
        const thresholdsSnapshot = {
          threshold1Minor: thresholds.threshold1Minor.toString(),
          threshold2Minor: thresholds.threshold2Minor.toString(),
          threshold3Minor: thresholds.threshold3Minor.toString(),
          effectiveSourceLevel: settingValue.effectiveSourceLevel,
          isLocked: settingValue.isLocked,
          resolvedAt: new Date().toISOString(),
        };

        if (band === 'auto') {
          const decidedAt = new Date();
          const updateResult = await tx.purchaseOrder.updateMany({
            where: { id, version: dto.expectedVersion },
            data: {
              status: 'approved',
              version: nextVersion,
              approvalBand: 'auto',
              approvalRequiredPermission: null,
              approvalThresholdsSnapshot: thresholdsSnapshot,
              evaluatedTotalAtSubmission: po.grandTotal,
              approvalRequestId: null,
              approvedBand: 'auto',
              approvedAt: decidedAt,
              approvedBy: null,
              updatedAt: decidedAt,
            },
          });
          if (updateResult.count === 0) {
            throw new ConflictException(
              'Version mismatch: the purchase order changed concurrently.',
            );
          }
          const updated = await tx.purchaseOrder.findUniqueOrThrow({
            where: { id },
            include: { lines: true },
          });

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.PURCHASE_ORDER_SUBMITTED,
            entityType: AUDIT_ENTITY.PURCHASE_ORDER,
            actorType: 'user',
            actorId: actorUserId,
            entityId: id,
            before: { status: po.status, version: po.version },
            metadata: { band: 'auto', grandTotal: po.grandTotal.toString() },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.PURCHASE_ORDER_APPROVED,
            entityType: AUDIT_ENTITY.PURCHASE_ORDER,
            actorType: 'system',
            actorId: actorUserId,
            entityId: id,
            metadata: { band: 'auto', approvedBy: null },
          });

          const payload: PurchaseOrderApprovedPayload = {
            purchaseOrderId: id,
            supplierId: po.supplierId,
            deliveryLocationType: po.deliveryLocationType,
            deliveryLocationId: po.deliveryLocationId,
            currency: po.currency,
            grandTotalMinor: po.grandTotal.toString(),
            approvalBand: 'auto',
            approvedBy: null,
            approvedAt: decidedAt.toISOString(),
          };
          ctx.publishEvent({
            eventType: PURCHASE_ORDER_APPROVED_EVENT_TYPE,
            eventVersion: PURCHASE_ORDER_APPROVED_EVENT_VERSION,
            occurredAt: decidedAt,
            branchId: po.lines[0].attributionBranchId,
            actorId: actorUserId,
            actorType: 'system',
            idempotencyKey: `purchase_order.approved:${id}:auto`,
            payload,
          });

          return updated;
        }

        const requiredPermission = requiredPermissionForBand(band, {
          tier1: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
          tier2: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
          tier3: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_3,
        })!;
        const approvalRequestId = newId();
        const expiresAt = new Date(Date.now() + PO_APPROVAL_REQUEST_TTL_MS);

        await this.approvals.createRequest(tx, tenantId, actorUserId, {
          id: approvalRequestId,
          requestType: 'purchase_order.approve',
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          entityId: id,
          value: {
            purchaseOrderId: id,
            totalMinor: po.grandTotal.toString(),
            currency: po.currency,
            band,
          },
          requiredPermission,
          expiresAt,
          // FR-SEC-016/D-7 — hard segregation of duties: the requester (whoever
          // submitted this PO) may never be the one who approves it.
          excludedApproverUserId: po.requestedBy,
        });

        const updateResult = await tx.purchaseOrder.updateMany({
          where: { id, version: dto.expectedVersion },
          data: {
            status: 'pending_approval',
            version: nextVersion,
            approvalBand: band,
            approvalRequiredPermission: requiredPermission,
            approvalThresholdsSnapshot: thresholdsSnapshot,
            evaluatedTotalAtSubmission: po.grandTotal,
            approvalRequestId,
            approvedBand: null,
            approvedAt: null,
            approvedBy: null,
            updatedAt: new Date(),
          },
        });
        if (updateResult.count === 0) {
          throw new ConflictException(
            'Version mismatch: the purchase order changed concurrently.',
          );
        }
        const updated = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id },
          include: { lines: true },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_ORDER_SUBMITTED,
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: id,
          before: { status: po.status, version: po.version },
          metadata: {
            band,
            requiredPermission,
            approvalRequestId,
            grandTotal: po.grandTotal.toString(),
          },
        });

        return updated;
      },
    );
  }
}
