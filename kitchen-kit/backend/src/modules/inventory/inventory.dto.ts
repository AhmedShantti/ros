import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UUID_PATTERN } from '../../common/ids';
import {
  BatchStrategy,
  CostingMethod,
  CountScope,
  MovementType,
} from '../../generated/prisma/client';

const uuid = (f: string) =>
  Matches(UUID_PATTERN, { message: `${f} must be a UUID` });
/** Signed 6-dp decimal as a string, so precision survives JSON (BR-CORE-003). */
const DECIMAL = /^-?\d{1,12}(\.\d{1,6})?$/;
const INT_STR = /^-?\d{1,18}$/;

export class CreateStockItemDto {
  @IsString() @Length(1, 32) sku!: string;
  @IsObject() names!: Record<string, unknown>;
  @uuid('baseUnitId') baseUnitId!: string;
  @IsOptional() @uuid('recipeUnitId') recipeUnitId?: string;
  @IsOptional() @uuid('categoryId') categoryId?: string;
  @IsOptional() @IsEnum(CostingMethod) costingMethod?: CostingMethod;
  @IsOptional() @Matches(INT_STR) standardCost?: string;
  @IsOptional() @IsBoolean() isBatchTracked?: boolean;
  @IsOptional() @IsBoolean() expiryTracked?: boolean;
  @IsOptional() @IsInt() @Min(0) shelfLifeDays?: number;
  @IsOptional() @IsEnum(BatchStrategy) batchStrategy?: BatchStrategy;
  @IsOptional() @IsObject() storageRequirements?: Record<string, unknown>;
}

export class ChangeBaseUnitDto {
  @uuid('baseUnitId') baseUnitId!: string;
}

export class SetReorderConfigDto {
  @uuid('locationId') locationId!: string;
  @Matches(DECIMAL) reorderPoint!: string;
  @Matches(DECIMAL) reorderQuantity!: string;
}

export class CreateReasonCodeDto {
  @IsString() @Length(1, 16) category!: string;
  @IsString() @Length(1, 32) code!: string;
  @IsObject() label!: Record<string, unknown>;
}

export class PostMovementDto {
  @uuid('locationId') locationId!: string;
  @uuid('stockItemId') stockItemId!: string;
  @IsEnum(MovementType) movementType!: MovementType;
  @Matches(DECIMAL) quantity!: string;
  @IsString() @Length(1, 32) referenceType!: string;
  @uuid('referenceId') referenceId!: string;
  @IsOptional() @uuid('reasonCodeId') reasonCodeId?: string;
  @IsOptional() @Matches(INT_STR) unitCost?: string;
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}

export class DispatchTransferDto {
  @uuid('stockItemId') stockItemId!: string;
  @uuid('fromLocationId') fromLocationId!: string;
  @uuid('toLocationId') toLocationId!: string;
  @Matches(DECIMAL) quantity!: string;
  @IsOptional() @uuid('reasonCodeId') reasonCodeId?: string;
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}

export class ReceiveTransferDto {
  @uuid('toLocationId') toLocationId!: string;
  @uuid('transferReferenceId') transferReferenceId!: string;
  @Matches(DECIMAL) receivedQuantity!: string;
  @IsOptional()
  @uuid('discrepancyReasonCodeId')
  discrepancyReasonCodeId?: string;
}

export class OpenCountDto {
  @uuid('locationId') locationId!: string;
  @IsEnum(CountScope) scopeType!: CountScope;
  @IsOptional() @uuid('scopeId') scopeId?: string;
  @IsOptional()
  @IsArray()
  @Matches(UUID_PATTERN, { each: true })
  itemIds?: string[];
  @IsOptional() @IsBoolean() isBlindCount?: boolean;
  /** B-2: caller-supplied approval gate; Inventory never evaluates a threshold. */
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
}

export class RecordCountDto {
  @Matches(DECIMAL) countedQuantity!: string;
}

export class WasteLineDto {
  @uuid('stockItemId') stockItemId!: string;
  @Matches(DECIMAL) quantity!: string;
}

export class RecordWasteDto {
  @uuid('locationId') locationId!: string;
  @uuid('reasonCodeId') reasonCodeId!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WasteLineDto)
  lines!: WasteLineDto[];
  /** B-2: caller-supplied approval gate. */
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsString() @Length(1, 500) notes?: string;
}
