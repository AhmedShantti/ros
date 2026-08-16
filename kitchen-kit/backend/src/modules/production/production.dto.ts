import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Ids are ULIDs stored as UUID. `@IsUUID()` rejects them (ULID-as-UUID does not
 * carry an RFC-4122 version nibble), so the project validates the shape.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECIPE_SCOPES = ['tenant', 'brand', 'branch'] as const;
const RECIPE_TYPES = ['menu_item', 'sub_recipe', 'production_item'] as const;
const COMPONENT_TYPES = ['stock_item', 'sub_recipe'] as const;

export class CreateRecipeDto {
  @IsIn(RECIPE_SCOPES)
  scope!: (typeof RECIPE_SCOPES)[number];

  /** D-17-03: required for `brand` scope, forbidden otherwise. */
  @IsOptional() @Matches(UUID_PATTERN) brandId?: string;

  /** D-17-03: required for `branch` scope, forbidden otherwise. */
  @IsOptional() @Matches(UUID_PATTERN) branchId?: string;

  @IsIn(RECIPE_TYPES)
  recipeType!: (typeof RECIPE_TYPES)[number];

  /** Required when `recipeType = menu_item`. */
  @IsOptional() @Matches(UUID_PATTERN) menuItemVariantId?: string;

  /** Required when `recipeType` is `sub_recipe` or `production_item`. */
  @IsOptional() @Matches(UUID_PATTERN) stockItemId?: string;
}

export class RecipeLineDto {
  @IsInt() @Min(0) @Max(32767) sequence!: number;

  @IsIn(COMPONENT_TYPES)
  componentType!: (typeof COMPONENT_TYPES)[number];

  @IsOptional() @Matches(UUID_PATTERN) stockItemId?: string;

  /** A sub-recipe component references LOGICAL RECIPE IDENTITY, not a version. */
  @IsOptional() @Matches(UUID_PATTERN) subRecipeId?: string;

  /** 6-dp decimal carried as a string end to end (BR-CORE-003). */
  @IsNumberString() quantity!: string;

  /** MUST be a real `inventory.uom` id; Production Spec never creates UOMs. */
  @Matches(UUID_PATTERN) unitId!: string;

  @IsOptional() @IsNumberString() wastagePercentage?: string;
  @IsOptional() @IsBoolean() isOptional?: boolean;
  @IsOptional() @Matches(UUID_PATTERN) substituteGroupId?: string;
}

export class CreateRecipeVersionDto {
  @IsNumberString() yieldQuantity!: string;

  @Matches(UUID_PATTERN) yieldUnitId!: string;

  @IsOptional() @IsNumberString() yieldPercentage?: string;

  @IsOptional() @IsInt() @Min(0) prepTimeSeconds?: number;

  /**
   * D-17-08 Q2 — INFORMATIONAL ONLY. Accepted, stored and returned. It is
   * never read by publish, resolution or any selection predicate.
   */
  @IsOptional() @IsString() effectiveFrom?: string;

  @IsOptional() @IsObject() instructions?: Record<string, unknown>;
  @IsOptional() @IsObject() referenceImages?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  lines?: RecipeLineDto[];
}

export class ReplaceRecipeLinesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  lines!: RecipeLineDto[];
}

export class CreateSubstituteGroupDto {
  @IsString() @MaxLength(120) name!: string;

  @IsOptional()
  @IsArray()
  @Matches(UUID_PATTERN, { each: true })
  stockItemIds?: string[];
}

export class AddSubstituteMemberDto {
  @Matches(UUID_PATTERN) stockItemId!: string;
}
