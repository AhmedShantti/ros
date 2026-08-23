import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { UUID_PATTERN } from '../../common/ids';
import { ModifierKind, PriceListScope } from '../../generated/prisma/client';

/**
 * Catalogue DTOs. No DTO accepts `tenantId` — the tenant comes only from the
 * validated TenantContext — and unknown properties are rejected by the global
 * ValidationPipe (`forbidNonWhitelisted`).
 *
 * Localised fields are JSON objects ({"ar": "...", "en": "..."}) per the approved
 * SQL; no key schema is imposed because the SRS defines none.
 */

const uuid = (field: string) =>
  Matches(UUID_PATTERN, { message: `${field} must be a UUID` });

// ------------------------------------------------------------------ menus --
export class CreateMenuDto {
  @IsObject()
  name!: Record<string, unknown>;

  /** FR-MNU-002. Vocabulary owned by Sales; stored as text (no Sales dependency). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orderTypes?: string[];

  @IsOptional()
  @IsObject()
  activeWindow?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(-32768)
  @Max(32767)
  priority?: number;
}

export class UpdateMenuDto {
  @IsOptional() @IsObject() name?: Record<string, unknown>;
  @IsOptional() @IsArray() @IsString({ each: true }) orderTypes?: string[];
  @IsOptional() @IsObject() activeWindow?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) priority?: number;
}

/** C-09: explicit lifecycle, never a generic PATCH field. */
export class SetActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

/** C-01 */
export class AssignBranchDto {
  @uuid('branchId')
  branchId!: string;
}

// ------------------------------------------------------------- categories --
export class CreateCategoryDto {
  @IsObject() name!: Record<string, unknown>;
  @IsOptional() @uuid('parentCategoryId') parentCategoryId?: string;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
  @IsOptional() @IsString() @Length(1, 9) colour?: string;
}

export class UpdateCategoryDto {
  @IsOptional() @IsObject() name?: Record<string, unknown>;
  @IsOptional() @uuid('parentCategoryId') parentCategoryId?: string;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
  @IsOptional() @IsString() @Length(1, 9) colour?: string;
}

// ------------------------------------------------------------- menu items --
export class CreateMenuItemDto {
  @IsObject() names!: Record<string, unknown>;
  @IsOptional() @IsObject() kitchenNames?: Record<string, unknown>;
  @IsOptional() @IsObject() aggregatorNames?: Record<string, unknown>;
  @IsOptional() @IsObject() description?: Record<string, unknown>;

  /** C-04: recorded only. Fiscal is out of scope, so this is never resolved. */
  @IsOptional() @uuid('taxClassId') taxClassId?: string;

  @IsOptional() @IsString() @Length(1, 32) revenueAccountCode?: string;
  @IsOptional() @IsString() @Length(1, 32) barcodePlu?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) allergens?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) dietaryTags?: string[];
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
  @IsOptional() @IsString() @Length(1, 9) colour?: string;
  @IsOptional() @IsBoolean() isCombo?: boolean;
  @IsOptional() @IsBoolean() isOpenPrice?: boolean;
  @IsOptional() @IsBoolean() isWeighed?: boolean;
}

export class UpdateMenuItemDto extends CreateMenuItemDto {
  @IsOptional() @IsObject() declare names: Record<string, unknown>;
}

/** C-02: placement, not ownership. */
export class PlaceMenuItemDto {
  @uuid('categoryId')
  categoryId!: string;
}

export class CreateVariantDto {
  @IsObject() name!: Record<string, unknown>;
  @IsOptional() @IsString() @Length(1, 32) barcode?: string;
  @IsOptional() @IsInt() @Min(0) prepTimeSeconds?: number;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
}

export class LinkModifierGroupDto {
  @uuid('modifierGroupId') modifierGroupId!: string;
  @IsOptional() @IsObject() priceOverride?: Record<string, unknown>;
  @IsOptional() @IsObject() defaultSelectionOverride?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
}

// -------------------------------------------------------- modifier groups --
export class CreateModifierGroupDto {
  @IsObject() name!: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(0) @Max(32767) minSelections?: number;
  @IsOptional() @IsInt() @Min(0) @Max(32767) maxSelections?: number;
  @IsOptional() @IsBoolean() isRequired?: boolean;
  @IsOptional() @IsBoolean() allowRepeat?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(32767) freeQuantityThreshold?: number;
}

export class UpdateModifierGroupDto extends CreateModifierGroupDto {
  @IsOptional() @IsObject() declare name: Record<string, unknown>;
}

export class CreateModifierDto {
  @IsObject() name!: Record<string, unknown>;

  /**
   * FR-POS-021 [M]. REQUIRED — P1E-5. Pre-existing rows may carry `kind:
   * null` (no non-heuristic source data could classify them; see the
   * catalogue-modifier-kind migration header), but every NEW modifier
   * created through this API must state its semantic kind explicitly.
   */
  @IsEnum(ModifierKind)
  kind!: ModifierKind;

  /** Minor units as an integer string, so BIGINT precision survives JSON. */
  @IsOptional()
  @Matches(/^-?\d{1,18}$/, { message: 'priceDelta must be an integer string' })
  priceDelta?: string;

  /** FR-MNU-012: recorded only — Inventory is out of scope. */
  @IsOptional() @uuid('stockItemId') stockItemId?: string;
  @IsOptional() @Matches(/^-?\d+(\.\d{1,6})?$/) consumptionQuantity?: string;
  @IsOptional() @uuid('consumptionUnitId') consumptionUnitId?: string;

  /** FR-MNU-013: opaque JSON — Production Spec is not implemented. */
  @IsOptional() @IsObject() recipeDelta?: Record<string, unknown>;

  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) sortOrder?: number;
}

// ------------------------------------------------------------ price lists --
export class CreatePriceListDto {
  @IsString() @Length(1, 120) name!: string;

  /** C-06: `branch_group` is intentionally absent from the enum. */
  @IsEnum(PriceListScope)
  scopeType!: PriceListScope;

  @IsOptional() @uuid('scopeId') scopeId?: string;
  @IsOptional() @IsString() @Length(1, 16) orderType?: string;
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validTo?: string;
  @IsOptional() @IsObject() recurrenceRule?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(-32768) @Max(32767) priority?: number;
  @IsOptional() @IsIn(['scheduled', 'active', 'expired']) status?: string;
}

export class SetPriceEntryDto {
  @uuid('menuItemVariantId') menuItemVariantId!: string;

  @Matches(/^-?\d{1,18}$/, { message: 'price must be an integer string' })
  price!: string;

  @IsString() @Length(3, 3) @Matches(/^[A-Z]{3}$/) currency!: string;
}

// ----------------------------------------------------------- availability --
export class CreateAvailabilityRuleDto {
  @IsOptional() @uuid('menuItemId') menuItemId?: string;
  @IsOptional() @uuid('variantId') variantId?: string;
  @IsOptional() @uuid('branchId') branchId?: string;
  @IsOptional() @IsString() @Length(1, 16) channel?: string;
  @IsOptional() @IsInt() @Min(0) @Max(6) dayOfWeek?: number;
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  startsAt?: string;
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  endsAt?: string;
}

export class Toggle86Dto {
  @IsBoolean() isManual86!: boolean;
  @IsOptional() @IsDateString() autoReenableAt?: string;
  @IsOptional() @IsString() @IsNotEmpty() @Length(1, 500) reasonText?: string;
}
