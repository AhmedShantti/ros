import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  STOCK_ITEM_PURCHASING_FACTS_QUERY,
  type StockItemPurchasingFactsQuery,
} from '../../inventory/contract';
import {
  BRANCH_BRAND_QUERY,
  type BranchBrandQuery,
} from '../../organisation/contract';
import type {
  CreateRequisitionDto,
  CreateRequisitionLineDto,
} from '../procurement.dto';

/**
 * FR-PRC-015 [S] — Purchase Requisition. Minimum lifecycle
 * (draft -> submitted -> converted); no requisition-level approval workflow
 * (mission brief §1: "do not invent complex requisition approval if not
 * required for creating the PO"). Consolidation into a PurchaseOrder, and
 * the `submitted -> converted` transition, live in
 * `purchase-orders.service.ts` (FR-PRC-016), not here — this service owns
 * only the requisition's own lifecycle.
 */
@Injectable()
export class RequisitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STOCK_ITEM_PURCHASING_FACTS_QUERY)
    private readonly purchasingFacts: StockItemPurchasingFactsQuery,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchFacts: BranchBrandQuery,
  ) {}

  private async validateLine(
    tx: Prisma.TransactionClient,
    tenantId: string,
    line: CreateRequisitionLineDto,
  ): Promise<void> {
    const facts = await this.purchasingFacts.find(tx, {
      tenantId,
      stockItemId: line.stockItemId,
    });
    if (!facts || !facts.isActive) {
      throw new NotFoundException(
        `Stock item ${line.stockItemId} not found or inactive.`,
      );
    }
    if (!facts.purchaseUnits.some((u) => u.id === line.purchaseUnitId)) {
      throw new BadRequestException(
        `purchaseUnitId ${line.purchaseUnitId} is not a valid purchase unit ` +
          `for stock item ${line.stockItemId}.`,
      );
    }
    if (new Prisma.Decimal(line.quantity).lte(0)) {
      throw new BadRequestException('Requisition line quantity must be > 0.');
    }
    if (line.preferredSupplierId) {
      const link = await tx.supplierItemLink.findFirst({
        where: {
          tenantId,
          supplierId: line.preferredSupplierId,
          stockItemId: line.stockItemId,
          isActive: true,
        },
        include: { supplier: true },
      });
      if (!link || link.supplier.status !== 'active') {
        throw new BadRequestException(
          `preferredSupplierId ${line.preferredSupplierId} must be an ` +
            `active supplier that actively sources stock item ${line.stockItemId}.`,
        );
      }
    }
  }

  async create(
    tenantId: string,
    actorUserId: string,
    dto: CreateRequisitionDto,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const branch = await this.branchFacts.findBranchAuthorizationFacts(
          tx,
          dto.requestingBranchId,
        );
        if (!branch) {
          throw new NotFoundException(
            `Branch ${dto.requestingBranchId} not found.`,
          );
        }
        if (!branch.isActive) {
          throw new UnprocessableEntityException(
            `Branch ${dto.requestingBranchId} is not active.`,
          );
        }

        for (const line of dto.lines ?? []) {
          await this.validateLine(tx, tenantId, line);
        }

        const requisitionId = newId();
        // A nested `lines: { create: [...] } }` here hits a genuine Prisma 7
        // checked/unchecked nested-write ambiguity ("Unknown argument
        // tenantId") because `PurchaseRequisitionLine` declares an explicit
        // `tenant` relation alongside its scalar `tenantId` FK column — see
        // `purchase-orders.service.ts#create`'s identical fix for the full
        // explanation. Lines are inserted via a separate `createMany`.
        await tx.purchaseRequisition.create({
          data: {
            id: requisitionId,
            tenantId,
            requestingBranchId: dto.requestingBranchId,
            requestedBy: actorUserId,
            status: 'draft',
            notes: dto.notes,
          },
        });
        if (dto.lines && dto.lines.length > 0) {
          await tx.purchaseRequisitionLine.createMany({
            data: dto.lines.map((line) => ({
              id: newId(),
              tenantId,
              requisitionId,
              stockItemId: line.stockItemId,
              quantity: new Prisma.Decimal(line.quantity),
              purchaseUnitId: line.purchaseUnitId,
              preferredSupplierId: line.preferredSupplierId,
              notes: line.notes,
            })),
          });
        }
        const requisition = await tx.purchaseRequisition.findUniqueOrThrow({
          where: { id: requisitionId },
          include: { lines: true },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_REQUISITION_CREATED,
          entityType: AUDIT_ENTITY.PURCHASE_REQUISITION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: requisition.id,
          metadata: {
            requestingBranchId: requisition.requestingBranchId,
            lineCount: requisition.lines.length,
          },
        });

        return requisition;
      },
    );
  }

  async findAll(
    tenantId: string,
    actorUserId: string,
    filter: { status?: string; requestingBranchId?: string },
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      (tx) =>
        tx.purchaseRequisition.findMany({
          where: {
            status: filter.status as never,
            requestingBranchId: filter.requestingBranchId,
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
        tx.purchaseRequisition.findUnique({
          where: { id },
          include: { lines: true },
        }),
    );
  }

  /** FR-PRC-015 invariant: a submitted requisition has >= 1 line. */
  async submit(tenantId: string, actorUserId: string, id: string) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const requisition = await tx.purchaseRequisition.findUnique({
          where: { id },
          include: { lines: true },
        });
        if (!requisition) throw new NotFoundException('Requisition not found.');
        if (requisition.status !== 'draft') {
          throw new UnprocessableEntityException(
            `Requisition ${id} is '${requisition.status}', not 'draft' — only ` +
              'a draft requisition can be submitted.',
          );
        }
        if (requisition.lines.length === 0) {
          throw new UnprocessableEntityException(
            'A submitted requisition must have at least one line (FR-PRC-015).',
          );
        }

        const submittedAt = new Date();
        const updated = await tx.purchaseRequisition.update({
          where: { id },
          data: { status: 'submitted', submittedAt },
          include: { lines: true },
        });

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.PURCHASE_REQUISITION_SUBMITTED,
          entityType: AUDIT_ENTITY.PURCHASE_REQUISITION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: id,
          before: { status: requisition.status },
          metadata: { status: updated.status, lineCount: updated.lines.length },
        });

        return updated;
      },
    );
  }
}
