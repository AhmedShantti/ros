import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import type {
  PurchaseOrder,
  PurchaseOrderLine,
} from '../../../generated/prisma/client';
import { Prisma } from '../../../generated/prisma/client';
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
import { PROCUREMENT_PERMISSIONS } from '../procurement.permissions';
import type { AmendPurchaseOrderDto } from '../procurement.dto';
import {
  PurchaseOrderLineBuilder,
  type BuiltPurchaseOrderLine,
} from './purchase-order-line-builder.service';
import { computeHeaderTotals } from './po-totals';
import { assertPoVersion } from './po-state';
import {
  PO_APPROVAL_THRESHOLDS_SETTING_KEY,
  bandCovers,
  parsePoApprovalThresholds,
  requireConfiguredThresholds,
  requiredPermissionForBand,
  resolveApprovalBand,
} from './po-thresholds';

/** FR-PRC-023 §10 amendment expiry — see `purchase-orders.service.ts`'s own
 *  docblock on `PO_APPROVAL_REQUEST_TTL_MS`; the same recorded judgment
 *  call applies here (D-10 mandates an explicit value, no default exists). */
const PO_AMENDMENT_APPROVAL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function snapshotPo(
  po: PurchaseOrder & { lines: readonly PurchaseOrderLine[] },
) {
  return {
    subtotal: po.subtotal.toString(),
    taxTotal: po.taxTotal.toString(),
    grandTotal: po.grandTotal.toString(),
    lines: po.lines.map((l) => ({
      id: l.id,
      stockItemId: l.stockItemId,
      purchaseUnitId: l.purchaseUnitId,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      netAmount: l.netAmount.toString(),
      taxAmount: l.taxAmount.toString(),
      lineTotal: l.lineTotal.toString(),
      sourceRequisitionLineId: l.sourceRequisitionLineId,
      attributionBranchId: l.attributionBranchId,
    })),
  };
}

/**
 * FR-PRC-023 [M] — Approved POs are amendable before any Goods Receipt
 * exists (`receivingStartedAt` — the narrow seam §15 asks for). Append-only
 * `PurchaseOrderAmendment` history; approval band is re-evaluated against
 * CURRENT configured thresholds (never the submission-time snapshot),
 * per the mission brief §10's ratified reapproval rule.
 */
@Injectable()
export class PurchaseOrderAmendmentService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    private readonly lineBuilder: PurchaseOrderLineBuilder,
    @Inject(EFFECTIVE_SETTING_QUERY)
    private readonly effectiveSetting: EffectiveSettingQuery,
    @Inject(APPROVAL_COMMANDS)
    private readonly approvals: ApprovalCommands,
  ) {}

  async amend(
    tenantId: string,
    actorUserId: string,
    id: string,
    dto: AmendPurchaseOrderDto,
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
        if (po.status !== 'approved') {
          throw new UnprocessableEntityException(
            `Purchase order ${id} is '${po.status}' — only an 'approved' ` +
              'purchase order may be amended.',
          );
        }
        if (po.receivingStartedAt) {
          throw new UnprocessableEntityException(
            `Purchase order ${id} cannot be amended — receiving has already begun.`,
          );
        }
        const nextVersion = assertPoVersion(po.version, dto.expectedVersion);
        if (!po.approvedBand) {
          // Structurally unreachable: `status = 'approved'` is only ever set
          // together with `approvedBand` (submit()/decide()). Guarded anyway
          // rather than silently coercing a null band.
          throw new UnprocessableEntityException(
            `Purchase order ${id} has no recorded approved band.`,
          );
        }

        const beforeSnapshot = snapshotPo(po);

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
        if (dto.lines) {
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
          const touchedRequisitionIds = new Set<string>();
          for (const line of built) {
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
        }

        const settingValue = await this.effectiveSetting.getEffectiveSetting(
          tx,
          tenantId,
          { settingKey: PO_APPROVAL_THRESHOLDS_SETTING_KEY },
        );
        requireConfiguredThresholds(settingValue.hasEffectiveValue);
        const thresholds = parsePoApprovalThresholds(
          settingValue.effectiveValue,
        );
        const newBand = resolveApprovalBand(
          headerTotals.grandTotalMinor,
          thresholds,
        );
        const oldApprovedBand = po.approvedBand;

        const staysApproved = bandCovers(oldApprovedBand, newBand);
        const thresholdsSnapshot = {
          threshold1Minor: thresholds.threshold1Minor.toString(),
          threshold2Minor: thresholds.threshold2Minor.toString(),
          threshold3Minor: thresholds.threshold3Minor.toString(),
          effectiveSourceLevel: settingValue.effectiveSourceLevel,
          isLocked: settingValue.isLocked,
          resolvedAt: new Date().toISOString(),
        };

        let approvalRequestId: string | null = po.approvalRequestId;
        const statusFields: Prisma.PurchaseOrderUpdateManyMutationInput = {};
        if (staysApproved) {
          // §10 — "if it remains inside the already-approved authority band:
          // preserve approval." approvedBand/approvedAt/approvedBy are
          // deliberately left UNCHANGED — the original decision still covers
          // this (same-or-lower) band.
          statusFields.status = 'approved';
        } else {
          const requiredPermission = requiredPermissionForBand(newBand, {
            tier1: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_1,
            tier2: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_2,
            tier3: PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_APPROVE_TIER_3,
          })!;
          approvalRequestId = newId();
          const expiresAt = new Date(
            Date.now() + PO_AMENDMENT_APPROVAL_REQUEST_TTL_MS,
          );
          await this.approvals.createRequest(tx, tenantId, actorUserId, {
            id: approvalRequestId,
            requestType: 'purchase_order.approve',
            entityType: AUDIT_ENTITY.PURCHASE_ORDER,
            entityId: id,
            value: {
              purchaseOrderId: id,
              totalMinor: headerTotals.grandTotalMinor.toString(),
              currency: po.currency,
              band: newBand,
              amendment: true,
            },
            requiredPermission,
            expiresAt,
            excludedApproverUserId: po.requestedBy,
          });
          statusFields.status = 'pending_approval';
          statusFields.approvalRequiredPermission = requiredPermission;
          statusFields.approvedBand = null;
          statusFields.approvedAt = null;
          statusFields.approvedBy = null;
        }

        const updateResult = await tx.purchaseOrder.updateMany({
          where: { id, version: dto.expectedVersion },
          data: {
            ...statusFields,
            deliveryLocationType,
            deliveryLocationId,
            expectedDeliveryDate: dto.expectedDeliveryDate
              ? new Date(dto.expectedDeliveryDate)
              : po.expectedDeliveryDate,
            subtotal: headerTotals.subtotalMinor,
            taxTotal: headerTotals.taxTotalMinor,
            grandTotal: headerTotals.grandTotalMinor,
            approvalBand: newBand,
            approvalThresholdsSnapshot: thresholdsSnapshot,
            evaluatedTotalAtSubmission: headerTotals.grandTotalMinor,
            approvalRequestId,
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
        const afterSnapshot = snapshotPo(updated);

        const priorMax = await tx.purchaseOrderAmendment.aggregate({
          where: { purchaseOrderId: id },
          _max: { amendmentNumber: true },
        });
        const amendmentNumber = (priorMax._max.amendmentNumber ?? 0) + 1;

        await tx.purchaseOrderAmendment.create({
          data: {
            id: newId(),
            tenantId,
            purchaseOrderId: id,
            amendmentNumber,
            changedBy: actorUserId,
            reason: dto.reason,
            beforeSnapshot,
            afterSnapshot,
            oldTotal: po.grandTotal,
            newTotal: headerTotals.grandTotalMinor,
            oldApprovalBand: oldApprovedBand,
            newApprovalBand: newBand,
          },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_ORDER_AMENDED,
          entityType: AUDIT_ENTITY.PURCHASE_ORDER,
          actorType: 'user',
          actorId: actorUserId,
          entityId: id,
          before: {
            grandTotal: po.grandTotal.toString(),
            band: oldApprovedBand,
          },
          metadata: {
            amendmentNumber,
            reason: dto.reason,
            newTotal: headerTotals.grandTotalMinor.toString(),
            newBand,
            requiresReapproval: !staysApproved,
          },
        });

        return updated;
      },
    );
  }
}
