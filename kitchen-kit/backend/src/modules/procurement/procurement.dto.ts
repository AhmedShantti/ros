import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { UUID_PATTERN } from '../../common/ids';

const uuid = (f: string) =>
  Matches(UUID_PATTERN, { message: `${f} must be a UUID` });
const CURRENCY = /^[A-Z]{3}$/;
/** Signed 6-dp decimal as a string, so precision survives JSON (BR-CORE-003). */
const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;
/** Integer minor-unit money as a string. */
const INT_STR = /^-?\d{1,18}$/;

// ── Supplier — structured JSONB sub-shapes (§2) ────────────────────────────

class AddressDto {
  @IsString() @Length(1, 255) line1!: string;
  @IsOptional() @IsString() @Length(1, 255) line2?: string;
  @IsOptional() @IsString() @Length(1, 120) city?: string;
  @IsOptional() @IsString() @Length(1, 120) state?: string;
  @IsOptional() @IsString() @Length(1, 20) postalCode?: string;
  @IsOptional()
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be ISO-3166-1 alpha-2' })
  countryCode?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

class ContactDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(1, 64) role?: string;
  @IsOptional() @IsString() @Length(1, 32) phone?: string;
  @IsOptional() @IsString() @Length(1, 160) email?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

// ── Supplier master — FR-PRC-005 ───────────────────────────────────────────

export class CreateSupplierDto {
  @IsString() @Length(1, 32) code!: string;
  @IsString() @Length(1, 255) legalName!: string;
  @IsOptional() @IsString() @Length(1, 255) tradingName?: string;
  @IsOptional() @IsString() @Length(1, 64) taxRegistrationNumber?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AddressDto)
  addresses?: AddressDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts?: ContactDto[];

  @IsInt() @Min(0) paymentTermsNetDays!: number;
  @Matches(CURRENCY, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
  @IsInt() @Min(0) deliveryLeadTimeDays!: number;
  @Matches(INT_STR) minimumOrderValue!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  deliveryDays?: number[];
}

export class UpdateSupplierDto {
  @IsOptional() @IsString() @Length(1, 32) code?: string;
  @IsOptional() @IsString() @Length(1, 255) legalName?: string;
  @IsOptional() @IsString() @Length(1, 255) tradingName?: string;
  @IsOptional() @IsString() @Length(1, 64) taxRegistrationNumber?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AddressDto)
  addresses?: AddressDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ContactDto)
  contacts?: ContactDto[];

  @IsOptional() @IsInt() @Min(0) paymentTermsNetDays?: number;
  @IsOptional()
  @Matches(CURRENCY, { message: 'currency must be an ISO-4217 code' })
  currency?: string;
  @IsOptional() @IsInt() @Min(0) deliveryLeadTimeDays?: number;
  @IsOptional() @Matches(INT_STR) minimumOrderValue?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  deliveryDays?: number[];
}

export class SetSupplierStatusDto {
  @IsIn(['active', 'inactive']) status!: 'active' | 'inactive';
}

// ── Supplier <-> StockItem sourcing — FR-PRC-007 / FR-INV-005 ─────────────

export class CreateSupplierItemLinkDto {
  @uuid('supplierId') supplierId!: string;
  @uuid('stockItemId') stockItemId!: string;
  @IsOptional() @IsString() @Length(1, 64) supplierItemCode?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  supplierBarcodes?: string[];
  @IsOptional() @IsInt() @Min(0) preferenceRank?: number;
}

export class UpdateSupplierItemLinkDto {
  @IsOptional() @IsString() @Length(1, 64) supplierItemCode?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  supplierBarcodes?: string[];
  @IsOptional() @IsInt() @Min(0) preferenceRank?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ── Supplier price list — FR-PRC-006 ───────────────────────────────────────

class VolumeTierDto {
  @Matches(DECIMAL) minimumQuantity!: string;
  @Matches(INT_STR) unitPriceMinor!: string;
}

// ── Query DTOs ──────────────────────────────────────────────────────────────

export class ListSuppliersQueryDto {
  @IsOptional() @IsIn(['active', 'inactive']) status?: 'active' | 'inactive';
}

export class ListSourcingLinksQueryDto {
  @IsOptional() @uuid('supplierId') supplierId?: string;
  @IsOptional() @uuid('stockItemId') stockItemId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class PriceHistoryQueryDto {
  @uuid('supplierItemLinkId') supplierItemLinkId!: string;
}

export class EffectivePriceQueryDto {
  @uuid('supplierItemLinkId') supplierItemLinkId!: string;
  @IsOptional() @uuid('purchaseUnitId') purchaseUnitId?: string;
  @IsOptional() @IsDateString() at?: string;
}

export class ComparativePricingQueryDto {
  @uuid('stockItemId') stockItemId!: string;
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @Matches(DECIMAL) quantity?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// FULL-SRS-PRC-PURCHASE-ORDERS-P2 — Requisitions, Purchase Orders,
// Approval, Amendments.
// ═══════════════════════════════════════════════════════════════════════

// ── Purchase Requisition — FR-PRC-015 ──────────────────────────────────────

export class CreateRequisitionLineDto {
  @uuid('stockItemId') stockItemId!: string;
  @Matches(DECIMAL) quantity!: string;
  @uuid('purchaseUnitId') purchaseUnitId!: string;
  @IsOptional() @uuid('preferredSupplierId') preferredSupplierId?: string;
  @IsOptional() @IsString() @Length(1, 1000) notes?: string;
}

export class CreateRequisitionDto {
  @uuid('requestingBranchId') requestingBranchId!: string;
  @IsOptional() @IsString() @Length(1, 2000) notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateRequisitionLineDto)
  lines?: CreateRequisitionLineDto[];
}

export class ListRequisitionsQueryDto {
  @IsOptional() @IsIn(['draft', 'submitted', 'converted']) status?: string;
  @IsOptional() @uuid('requestingBranchId') requestingBranchId?: string;
}

// ── Purchase Order — FR-PRC-016/017 ────────────────────────────────────────

export class PurchaseOrderLineDto {
  /** Present to consolidate from a submitted requisition line; when set,
   *  `stockItemId`/`purchaseUnitId`/`quantity`/`attributionBranchId` are all
   *  taken from the requisition line and MUST NOT also be supplied. */
  @IsOptional()
  @uuid('sourceRequisitionLineId')
  sourceRequisitionLineId?: string;

  @IsOptional() @uuid('stockItemId') stockItemId?: string;
  @IsOptional() @Matches(DECIMAL) quantity?: string;
  @IsOptional() @uuid('purchaseUnitId') purchaseUnitId?: string;
  @IsOptional() @uuid('attributionBranchId') attributionBranchId?: string;

  /** Explicit, authorised negotiated price (minor units). Omit to resolve
   *  the current agreed SupplierPriceEntry automatically (mission brief §3). */
  @IsOptional() @Matches(INT_STR) unitPrice?: string;
  @IsOptional() @Matches(INT_STR) taxAmount?: string;
}

export class CreatePurchaseOrderDto {
  @uuid('supplierId') supplierId!: string;
  @IsIn(['branch', 'warehouse', 'central_kitchen'])
  deliveryLocationType!: 'branch' | 'warehouse' | 'central_kitchen';
  @uuid('deliveryLocationId') deliveryLocationId!: string;
  @IsDateString() expectedDeliveryDate!: string;
  @Matches(CURRENCY, { message: 'currency must be an ISO-4217 code' })
  currency!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class UpdatePurchaseOrderDto {
  @IsInt() expectedVersion!: number;
  @IsOptional()
  @IsIn(['branch', 'warehouse', 'central_kitchen'])
  deliveryLocationType?: 'branch' | 'warehouse' | 'central_kitchen';
  @IsOptional() @uuid('deliveryLocationId') deliveryLocationId?: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class SubmitPurchaseOrderDto {
  @IsInt() expectedVersion!: number;
}

export class ListPurchaseOrdersQueryDto {
  @IsOptional()
  @IsIn(['draft', 'pending_approval', 'approved', 'rejected'])
  status?: string;
  @IsOptional() @uuid('supplierId') supplierId?: string;
}

/** A PIN-verified manager decision — the ONLY manual approval-decision
 *  channel this repository's Governance runtime actually supports today
 *  (`TERMINAL_PIN_VERIFIER`). See `purchase-order-approval.service.ts`'s
 *  own docblock for why. */
export class DecidePurchaseOrderDto {
  @IsInt() expectedVersion!: number;
  /** FR-OFF-015-style client-generated permanent id for THIS decision. */
  @uuid('approvalDecisionId') approvalDecisionId!: string;
  @uuid('terminalId') terminalId!: string;
  @IsString() @Length(1, 32) employeeCode!: string;
  @IsString() @Length(4, 12) pin!: string;
  @IsOptional() @IsString() @Length(1, 1000) comment?: string;
}

export class AmendPurchaseOrderDto {
  @IsInt() expectedVersion!: number;
  @IsString() @Length(1, 2000) reason!: string;

  @IsOptional()
  @IsIn(['branch', 'warehouse', 'central_kitchen'])
  deliveryLocationType?: 'branch' | 'warehouse' | 'central_kitchen';
  @IsOptional() @uuid('deliveryLocationId') deliveryLocationId?: string;
  @IsOptional() @IsDateString() expectedDeliveryDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class CreateSupplierPriceEntryDto {
  @uuid('supplierItemLinkId') supplierItemLinkId!: string;
  @uuid('purchaseUnitId') purchaseUnitId!: string;
  @Matches(DECIMAL) packSize!: string;
  @Matches(INT_STR) unitPrice!: string;
  @Matches(CURRENCY, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
  @IsDateString() validFrom!: string;
  @IsOptional() @IsDateString() validUntil?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => VolumeTierDto)
  volumeTiers?: VolumeTierDto[];
}
