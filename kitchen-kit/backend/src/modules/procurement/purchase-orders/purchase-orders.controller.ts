import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { UUID_PATTERN } from '../../../common/ids';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import {
  AuthorizationTarget,
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequirePermission,
  TenantContextGuard,
  tenantTarget,
} from '../../identity/contract';
import type { TenantContext } from '../../identity/contract';
import {
  AmendPurchaseOrderDto,
  CreatePurchaseOrderDto,
  DecidePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  SubmitPurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from '../procurement.dto';
import { PROCUREMENT_PERMISSIONS } from '../procurement.permissions';
import {
  toPurchaseOrderAmendmentView,
  toPurchaseOrderView,
} from '../procurement.views';
import { PurchaseOrderAmendmentService } from './purchase-order-amendment.service';
import { PurchaseOrderApprovalService } from './purchase-order-approval.service';
import { PurchaseOrdersService } from './purchase-orders.service';

const purchaseOrderSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    supplierId: uuidSchema(),
    deliveryLocationType: {
      type: 'string',
      enum: ['branch', 'warehouse', 'central_kitchen'],
    },
    deliveryLocationId: uuidSchema(),
    expectedDeliveryDate: isoDateTimeSchema(),
    currency: { type: 'string' },
    status: {
      type: 'string',
      enum: ['draft', 'pending_approval', 'approved', 'rejected'],
    },
    requestedBy: uuidSchema(),
    subtotal: moneyStringSchema(),
    taxTotal: moneyStringSchema(),
    grandTotal: moneyStringSchema(),
    approvalBand: nullable({
      type: 'string',
      enum: ['auto', 'tier_1', 'tier_2', 'tier_3'],
    }),
    approvedBand: nullable({
      type: 'string',
      enum: ['auto', 'tier_1', 'tier_2', 'tier_3'],
    }),
    version: { type: 'integer' },
    lines: { type: 'array', items: { type: 'object' } },
  },
};

/**
 * FULL-SRS-PRC-PURCHASE-ORDERS-P2 §11 — FR-PRC-016/017/018/019/023 Purchase
 * Order. Back-office/console only (no `@AllowPosSession()`, mission brief
 * §11). See `requisitions.controller.ts`'s own docblock for why
 * `tenantTarget` is used uniformly here too.
 */
@ApiTags('procurement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('procurement/purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly approvalService: PurchaseOrderApprovalService,
    private readonly amendmentService: PurchaseOrderAmendmentService,
  ) {}

  @Post()
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async create(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.purchaseOrders.create(ctx.tenantId, ctx.userId, dto),
    );
  }

  @Get()
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: { type: 'array', items: purchaseOrderSchema } })
  async list(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: ListPurchaseOrdersQueryDto,
  ) {
    const rows = await this.purchaseOrders.findAll(ctx.tenantId, ctx.userId, {
      status: query.status,
      supplierId: query.supplierId,
    });
    return rows.map(toPurchaseOrderView);
  }

  @Get(':id')
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async getById(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    if (!UUID_PATTERN.test(id)) {
      throw new NotFoundException('Purchase order not found.');
    }
    const po = await this.purchaseOrders.findById(ctx.tenantId, ctx.userId, id);
    if (!po) throw new NotFoundException('Purchase order not found.');
    return toPurchaseOrderView(po);
  }

  @Patch(':id')
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async update(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.purchaseOrders.update(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async submit(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SubmitPurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.purchaseOrders.submit(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  // ── Approval — FR-PRC-018/019 §9. The route-level guard is deliberately
  // the GENERAL procurement-module permission, NOT one of the tier codes —
  // mirroring Treasury's identical `finalizeClose` precedent
  // (`treasury.controller.ts`: gated by the session-owner's own permission,
  // never `cash.variance.approve`). The caller reaching this HTTP route
  // (e.g. a back-office user relaying a manager's PIN decision) is not
  // necessarily the approving identity — the PIN-verified `approver` in the
  // request body is. The EXACT required tier for THIS purchase order's own
  // evaluated band is enforced by Governance's `ApprovalCommands.decide()`
  // itself, against the PIN-verified approver's permissions
  // (`ApproverNotPermittedError` -> 403) — the actual authority check. ────

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase order approval is a tenant-wide authority.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async approve(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DecidePurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.approvalService.approve(ctx.tenantId, id, dto),
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase order approval is a tenant-wide authority.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async reject(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: DecidePurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.approvalService.reject(ctx.tenantId, id, dto),
    );
  }

  @Post(':id/amend')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({ schema: purchaseOrderSchema })
  async amend(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AmendPurchaseOrderDto,
  ) {
    return toPurchaseOrderView(
      await this.amendmentService.amend(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  @Get(':id/amendments')
  @RequirePermission(PROCUREMENT_PERMISSIONS.PURCHASE_ORDER_CREATE)
  @AuthorizationTarget(
    tenantTarget('Purchase orders are tenant-wide purchasing data.'),
  )
  @ApiOkResponse({
    schema: { type: 'array', items: { type: 'object' } },
  })
  async listAmendments(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    const rows = await this.purchaseOrders.listAmendments(
      ctx.tenantId,
      ctx.userId,
      id,
    );
    return rows.map(toPurchaseOrderAmendmentView);
  }
}
