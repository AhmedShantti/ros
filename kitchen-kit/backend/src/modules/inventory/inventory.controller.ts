import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import { CountsService } from './counts/counts.service';
import {
  ChangeBaseUnitDto,
  CreateReasonCodeDto,
  CreateStockItemDto,
  DispatchTransferDto,
  OpenCountDto,
  PostMovementDto,
  ReceiveTransferDto,
  RecordCountDto,
  RecordWasteDto,
  SetReorderConfigDto,
} from './inventory.dto';
import { INVENTORY_PERMISSIONS } from './inventory.permissions';
import { MovementsService } from './movements/movements.service';
import { TransfersService } from './movements/transfers.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { StockItemsService } from './stock-items/stock-items.service';
import { WasteService } from './waste/waste.service';

/**
 * Inventory API.
 *
 * Guard chain unchanged: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). Authorization is TENANT-scoped; ADR 0008 D-02's
 * deferral of branch-scoped RBAC still stands, so no handler reads
 * `TenantContext.branchId`.
 *
 * All ten permission codes are SRS-attested (§15.2). None invented.
 * `inventory.cost.view` gates the cost-bearing reads specifically.
 */
@ApiTags('inventory')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly items: StockItemsService,
    private readonly movements: MovementsService,
    private readonly transfers: TransfersService,
    private readonly counts: CountsService,
    private readonly waste: WasteService,
    private readonly recon: ReconciliationService,
  ) {}

  // ------------------------------------------------------- stock item master --
  @Post('items')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  createItem(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateStockItemDto,
  ) {
    return this.items.create(c.tenantId, c.userId, dto);
  }

  @Get('items')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  listItems(@CurrentTenantContext() c: TenantContext) {
    return this.items.list(c.tenantId);
  }

  @Get('items/:itemId')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  getItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.findOne(c.tenantId, id);
  }

  /** FR-INV-002: rejected once any movement exists. */
  @Post('items/:itemId/base-unit')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  changeBaseUnit(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: ChangeBaseUnitDto,
  ) {
    return this.items.changeBaseUnit(c.tenantId, c.userId, id, dto.baseUnitId);
  }

  /** FR-INV-065: per-location reorder configuration. */
  @Post('items/:itemId/reorder-config')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  setReorderConfig(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: SetReorderConfigDto,
  ) {
    return this.items.setReorderConfig(
      c.tenantId,
      c.userId,
      id,
      dto.locationId,
      dto.reorderPoint,
      dto.reorderQuantity,
    );
  }

  @Post('reason-codes')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  createReasonCode(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateReasonCodeDto,
  ) {
    return this.items.createReasonCode(
      c.tenantId,
      c.userId,
      dto.category,
      dto.code,
      dto.label,
    );
  }

  @Get('reason-codes')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  listReasonCodes(@CurrentTenantContext() c: TenantContext) {
    return this.items.listReasonCodes(c.tenantId);
  }

  // ------------------------------------------------------------------ ledger --
  @Post('movements')
  @RequirePermission(INVENTORY_PERMISSIONS.ADJUST)
  postMovement(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: PostMovementDto,
  ) {
    return this.movements.postStandalone(c.tenantId, c.userId, {
      locationId: dto.locationId,
      stockItemId: dto.stockItemId,
      movementType: dto.movementType,
      quantity: Number(dto.quantity),
      referenceType: dto.referenceType,
      referenceId: dto.referenceId,
      reasonCodeId: dto.reasonCodeId,
      notes: dto.notes,
      ...(dto.unitCost !== undefined ? { unitCost: BigInt(dto.unitCost) } : {}),
    });
  }

  /** Cost-bearing read — gated by inventory.cost.view, not inventory.view. */
  @Get('items/:itemId/movements')
  @RequirePermission(INVENTORY_PERMISSIONS.COST_VIEW)
  listMovements(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') itemId: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.movements.listForItem(c.tenantId, itemId, locationId);
  }

  // --------------------------------------------------------------- transfers --
  @Post('transfers')
  @RequirePermission(INVENTORY_PERMISSIONS.TRANSFER_CREATE)
  dispatch(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: DispatchTransferDto,
  ) {
    return this.transfers.dispatch(c.tenantId, c.userId, {
      stockItemId: dto.stockItemId,
      fromLocationId: dto.fromLocationId,
      toLocationId: dto.toLocationId,
      quantity: Number(dto.quantity),
      reasonCodeId: dto.reasonCodeId,
      notes: dto.notes,
    });
  }

  @Post('transfers/receive')
  @RequirePermission(INVENTORY_PERMISSIONS.TRANSFER_RECEIVE)
  receive(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: ReceiveTransferDto,
  ) {
    return this.transfers.receive(c.tenantId, c.userId, dto.toLocationId, {
      transferReferenceId: dto.transferReferenceId,
      receivedQuantity: Number(dto.receivedQuantity),
      discrepancyReasonCodeId: dto.discrepancyReasonCodeId,
    });
  }

  // ------------------------------------------------------------------ counts --
  @Post('counts')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  openCount(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: OpenCountDto,
  ) {
    return this.counts.open(c.tenantId, c.userId, dto);
  }

  @Get('counts/:sessionId/lines')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  countLines(
    @CurrentTenantContext() c: TenantContext,
    @Param('sessionId') id: string,
  ) {
    return this.counts.lines(c.tenantId, id);
  }

  @Post('count-lines/:lineId')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_PERFORM)
  recordCount(
    @CurrentTenantContext() c: TenantContext,
    @Param('lineId') lineId: string,
    @Body() dto: RecordCountDto,
  ) {
    return this.counts.recordCount(
      c.tenantId,
      c.userId,
      lineId,
      Number(dto.countedQuantity),
    );
  }

  @Post('counts/:sessionId/post')
  @RequirePermission(INVENTORY_PERMISSIONS.COUNT_POST)
  postCount(
    @CurrentTenantContext() c: TenantContext,
    @Param('sessionId') id: string,
  ) {
    return this.counts.post(c.tenantId, c.userId, id);
  }

  // ------------------------------------------------------------------- waste --
  @Post('waste')
  @RequirePermission(INVENTORY_PERMISSIONS.WASTE_RECORD)
  recordWaste(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: RecordWasteDto,
  ) {
    return this.waste.record(c.tenantId, c.userId, {
      locationId: dto.locationId,
      reasonCodeId: dto.reasonCodeId,
      lines: dto.lines.map((l) => ({
        stockItemId: l.stockItemId,
        quantity: Number(l.quantity),
      })),
      requiresApproval: dto.requiresApproval,
      notes: dto.notes,
    });
  }

  @Get('waste')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  listWaste(@CurrentTenantContext() c: TenantContext) {
    return this.waste.list(c.tenantId);
  }

  // --------------------------------- levels / on-demand computations (D-INV-08) --
  @Get('levels')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  levels(
    @CurrentTenantContext() c: TenantContext,
    @Query('locationId') locationId?: string,
  ) {
    return this.recon.levels(c.tenantId, locationId);
  }

  /** FR-INV-011/051 computation. Scheduling deferred (D-INV-08). */
  @Get('reconciliation')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  reconcile(@CurrentTenantContext() c: TenantContext) {
    return this.recon.reconcile(c.tenantId);
  }

  /** FR-INV-014 computation. Alert delivery deferred. */
  @Get('negative-stock')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  negativeStock(@CurrentTenantContext() c: TenantContext) {
    return this.recon.negativeStock(c.tenantId);
  }

  /** FR-INV-024 computation. Alert delivery deferred. */
  @Get('expiring')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  expiring(
    @CurrentTenantContext() c: TenantContext,
    @Query('days') days?: string,
  ) {
    return this.recon.expiring(c.tenantId, days ? Number(days) : 7);
  }

  /** FR-INV-066 computation against per-location reorder points. */
  @Get('low-stock')
  @RequirePermission(INVENTORY_PERMISSIONS.VIEW)
  lowStock(@CurrentTenantContext() c: TenantContext) {
    return this.recon.lowStock(c.tenantId);
  }
}
