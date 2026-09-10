import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  decimalStringSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { UUID_PATTERN } from '../../common/ids';
import {
  AuthorizationTarget,
  CurrentTenantContext,
  JwtAuthGuard,
  PermissionGuard,
  RequireAnyPermission,
  RequirePermission,
  TenantContextGuard,
  tenantTarget,
} from '../identity/contract';
import type { TenantContext } from '../identity/contract';
import {
  ComparativePricingQueryDto,
  CreateSupplierDto,
  CreateSupplierItemLinkDto,
  CreateSupplierPriceEntryDto,
  EffectivePriceQueryDto,
  ListSourcingLinksQueryDto,
  ListSuppliersQueryDto,
  PriceHistoryQueryDto,
  SetSupplierStatusDto,
  UpdateSupplierDto,
  UpdateSupplierItemLinkDto,
} from './procurement.dto';
import {
  PROCUREMENT_PERMISSIONS,
  PURCHASE_ORDER_CREATE_PERMISSION,
} from './procurement.permissions';
import { PricingService } from './pricing/pricing.service';
import { SourcingService } from './sourcing/sourcing.service';
import { SuppliersService } from './suppliers/suppliers.service';
import {
  toPriceEntryView,
  toSourcingLinkView,
  toSupplierView,
} from './procurement.views';

const supplierSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    code: { type: 'string' },
    legalName: { type: 'string' },
    tradingName: nullable({ type: 'string' }),
    taxRegistrationNumber: nullable({ type: 'string' }),
    addresses: { type: 'array', items: { type: 'object' } },
    contacts: { type: 'array', items: { type: 'object' } },
    paymentTermsNetDays: { type: 'integer' },
    currency: { type: 'string', example: 'AED' },
    deliveryLeadTimeDays: { type: 'integer' },
    minimumOrderValue: moneyStringSchema(),
    deliveryDays: { type: 'array', items: { type: 'integer' } },
    status: { type: 'string', enum: ['active', 'inactive'] },
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
  },
};

const sourcingLinkSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    supplierId: uuidSchema(),
    stockItemId: uuidSchema(),
    supplierItemCode: nullable({ type: 'string' }),
    supplierBarcodes: { type: 'array', items: { type: 'string' } },
    preferenceRank: { type: 'integer' },
    isActive: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
    updatedAt: isoDateTimeSchema(),
  },
};

const priceEntrySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    supplierId: uuidSchema(),
    supplierItemLinkId: uuidSchema(),
    purchaseUnitId: uuidSchema(),
    packSize: decimalStringSchema(),
    unitPrice: moneyStringSchema(),
    currency: { type: 'string' },
    validFrom: isoDateTimeSchema(),
    validUntil: nullable(isoDateTimeSchema()),
    volumeTiers: nullable({ type: 'array', items: { type: 'object' } }),
    createdAt: isoDateTimeSchema(),
  },
};

/**
 * FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 — back-office/console only, no POS
 * token exposure (mission brief §12: no `@AllowPosSession()` anywhere in
 * this file). Every route declares an explicit `tenantTarget(...)` (B1-3):
 * Supplier/sourcing/price data is tenant-wide master data with no narrower
 * branch owner, the same classification `AuthorizationTargetSpec`'s own doc
 * comment names for "tenant master data, tenant-level registries".
 */
@ApiTags('procurement')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('procurement')
export class ProcurementController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly sourcing: SourcingService,
    private readonly pricing: PricingService,
  ) {}

  // ── Supplier master — FR-PRC-005 ─────────────────────────────────────────

  @Post('suppliers')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(tenantTarget('Supplier master is tenant-wide data.'))
  @ApiOkResponse({ schema: supplierSchema })
  async createSupplier(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateSupplierDto,
  ) {
    return toSupplierView(
      await this.suppliers.create(ctx.tenantId, ctx.userId, dto),
    );
  }

  @Get('suppliers')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(tenantTarget('Supplier master is tenant-wide data.'))
  @ApiOkResponse({ schema: { type: 'array', items: supplierSchema } })
  async listSuppliers(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: ListSuppliersQueryDto,
  ) {
    const rows = await this.suppliers.findAll(ctx.tenantId, ctx.userId, {
      status: query.status,
    });
    return rows.map(toSupplierView);
  }

  @Get('suppliers/:id')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(tenantTarget('Supplier master is tenant-wide data.'))
  @ApiOkResponse({ schema: supplierSchema })
  async getSupplier(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    if (!UUID_PATTERN.test(id))
      throw new NotFoundException('Supplier not found.');
    const supplier = await this.suppliers.findById(
      ctx.tenantId,
      ctx.userId,
      id,
    );
    if (!supplier) throw new NotFoundException('Supplier not found.');
    return toSupplierView(supplier);
  }

  @Patch('suppliers/:id')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(tenantTarget('Supplier master is tenant-wide data.'))
  @ApiOkResponse({ schema: supplierSchema })
  async updateSupplier(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return toSupplierView(
      await this.suppliers.update(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  @Patch('suppliers/:id/status')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(tenantTarget('Supplier master is tenant-wide data.'))
  @ApiOkResponse({ schema: supplierSchema })
  async setSupplierStatus(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SetSupplierStatusDto,
  ) {
    return toSupplierView(
      await this.suppliers.setStatus(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  // ── Supplier <-> StockItem sourcing — FR-PRC-007 / FR-INV-005 ───────────

  @Post('supplier-item-links')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(
    tenantTarget('Sourcing links are tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: sourcingLinkSchema })
  async createSourcingLink(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateSupplierItemLinkDto,
  ) {
    return toSourcingLinkView(
      await this.sourcing.createLink(ctx.tenantId, ctx.userId, dto),
    );
  }

  @Get('supplier-item-links')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(
    tenantTarget('Sourcing links are tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: { type: 'array', items: sourcingLinkSchema } })
  async listSourcingLinks(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: ListSourcingLinksQueryDto,
  ) {
    if (query.supplierId) {
      const rows = await this.sourcing.listForSupplier(
        ctx.tenantId,
        ctx.userId,
        query.supplierId,
        { isActive: query.isActive },
      );
      return rows.map(toSourcingLinkView);
    }
    if (query.stockItemId) {
      const rows = await this.sourcing.listForStockItem(
        ctx.tenantId,
        ctx.userId,
        query.stockItemId,
        { isActive: query.isActive },
      );
      return rows.map(toSourcingLinkView);
    }
    throw new NotFoundException(
      'Provide either supplierId or stockItemId to list sourcing links.',
    );
  }

  @Patch('supplier-item-links/:id')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(
    tenantTarget('Sourcing links are tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: sourcingLinkSchema })
  async updateSourcingLink(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierItemLinkDto,
  ) {
    return toSourcingLinkView(
      await this.sourcing.update(ctx.tenantId, ctx.userId, id, dto),
    );
  }

  // ── Supplier price list — FR-PRC-006 / FR-PRC-007 ───────────────────────

  @Post('supplier-price-entries')
  @RequirePermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE)
  @AuthorizationTarget(
    tenantTarget('Supplier price history is tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: priceEntrySchema })
  async createPriceEntry(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateSupplierPriceEntryDto,
  ) {
    return toPriceEntryView(
      await this.pricing.createPriceEntry(ctx.tenantId, ctx.userId, dto),
    );
  }

  @Get('supplier-price-entries')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(
    tenantTarget('Supplier price history is tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: { type: 'array', items: priceEntrySchema } })
  async priceHistory(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: PriceHistoryQueryDto,
  ) {
    const rows = await this.pricing.history(
      ctx.tenantId,
      ctx.userId,
      query.supplierItemLinkId,
    );
    return rows.map(toPriceEntryView);
  }

  @Get('supplier-price-entries/effective')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(
    tenantTarget('Supplier price history is tenant-wide configuration.'),
  )
  @ApiOkResponse({ schema: { type: 'array', items: priceEntrySchema } })
  async effectivePrice(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: EffectivePriceQueryDto,
  ) {
    const at = query.at ? new Date(query.at) : new Date();
    const rows = await this.pricing.effectivePrice(
      ctx.tenantId,
      ctx.userId,
      query.supplierItemLinkId,
      at,
      query.purchaseUnitId,
    );
    return rows.map(toPriceEntryView);
  }

  @Get('comparative-pricing')
  @RequireAnyPermission(
    PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
    PURCHASE_ORDER_CREATE_PERMISSION,
  )
  @AuthorizationTarget(
    tenantTarget(
      'Comparative supplier pricing is a tenant-wide purchasing read.',
    ),
  )
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          supplierId: uuidSchema(),
          supplierCode: { type: 'string' },
          supplierName: { type: 'string' },
          supplierStatus: { type: 'string', enum: ['active', 'inactive'] },
          supplierItemLinkId: uuidSchema(),
          preferenceRank: { type: 'integer' },
          supplierItemCode: nullable({ type: 'string' }),
          purchaseUnitId: uuidSchema(),
          packSize: decimalStringSchema(),
          currency: { type: 'string' },
          unitPrice: moneyStringSchema(),
          selectedTier: nullable({ type: 'object' }),
          validFrom: isoDateTimeSchema(),
          validUntil: nullable(isoDateTimeSchema()),
          volumeTiers: nullable({ type: 'array', items: { type: 'object' } }),
        },
      },
    },
  })
  comparativePricing(
    @CurrentTenantContext() ctx: TenantContext,
    @Query() query: ComparativePricingQueryDto,
  ) {
    const at = query.at ? new Date(query.at) : new Date();
    return this.pricing.comparativePricing(
      ctx.tenantId,
      ctx.userId,
      query.stockItemId,
      at,
      query.quantity,
    );
  }
}
