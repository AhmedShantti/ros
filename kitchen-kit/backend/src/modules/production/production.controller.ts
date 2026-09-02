import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  decimalStringSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import {
  AddSubstituteMemberDto,
  CreateRecipeDto,
  CreateRecipeVersionDto,
  CreateSubstituteGroupDto,
  RecipeCompletenessQueryDto,
  ReplaceModifierRecipeEffectsDto,
  ReplaceRecipeLinesDto,
} from './production.dto';
import { PRODUCTION_PERMISSIONS } from './production.permissions';
import { ModifierRecipeEffectsService } from './costing/modifier-recipe-effects.service';
import { RecipeCompletenessService } from './costing/recipe-completeness.service';
import { RecipesService } from './recipes/recipes.service';
import { SubstituteGroupsService } from './substitute-groups/substitute-groups.service';
import { RecipeVersionsService } from './versions/recipe-versions.service';
import { toRecipeView, toVersionView, toGroupView } from './production.views';
import {
  AuthorizationTarget,
  branchFromQueryOrTenant,
  declaredScopeFromBody,
  fromParam,
  resourceTarget,
  tenantTarget,
} from '../identity/contract';
import { PRODUCTION_RECIPE_TARGET_RESOLVER } from './contract';

/**
 * Production Spec API.
 *
 * Route surface, exactly as ratified by the design gate §14 (the SRS `/v1`
 * prefix is dropped, matching how `/inventory` and `/catalogue` map SRS §26.3):
 *
 *   POST /recipes                              GAP-1 ratified deviation
 *   GET  /recipes/:id/versions                 SRS §26.3 verbatim
 *   POST /recipes/:id/versions                 SRS §26.3 verbatim
 *   POST /recipes/:id/versions/:v/publish      SRS §26.3 verbatim
 *
 * Deliberately absent: any list/detail/update/delete route, and above all any
 * "effective recipe" endpoint. D-17-08 authorizes a selection RULE, not a
 * selection SURFACE — the SRS defines `GET /v1/menu` for menus and nothing
 * equivalent for recipes.
 *
 * Guard chain unchanged: JwtAuthGuard (401) -> TenantContextGuard (403) ->
 * PermissionGuard (403). Cross-tenant ids yield 404, never 403, so a response
 * cannot disclose that another tenant's resource exists.
 */

// Shapes verified against `production.views.ts` (`toRecipeView`/`toVersionView`/
// `toGroupView`) and, where a route returns a raw Prisma row instead of a view
// (`replaceLines`, `listGroups`, `addGroupMember`), against the corresponding
// Prisma model in `prisma/schema.prisma` — not against the SRS.
const recipeLineSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    sequence: { type: 'integer' },
    componentType: { type: 'string', enum: ['stock_item', 'sub_recipe'] },
    stockItemId: nullable(uuidSchema()),
    subRecipeId: nullable(uuidSchema()),
    quantity: decimalStringSchema(),
    unitId: uuidSchema(),
    wastagePercentage: decimalStringSchema(),
    isOptional: { type: 'boolean' },
    substituteGroupId: nullable(uuidSchema()),
  },
};

const recipeVersionSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    recipeId: uuidSchema(),
    version: { type: 'integer' },
    status: { type: 'string', enum: ['draft', 'published', 'superseded'] },
    yieldQuantity: decimalStringSchema(),
    yieldUnitId: uuidSchema(),
    yieldPercentage: decimalStringSchema(),
    prepTimeSeconds: nullable({ type: 'integer' }),
    computedCost: nullable(
      moneyStringSchema(
        'D-17-05: never populated by this phase; always null today.',
      ),
    ),
    costComputedAt: nullable(isoDateTimeSchema()),
    effectiveFrom: nullable(
      isoDateTimeSchema(
        'Informational only (D-17-08 Q2) — never consulted in selection.',
      ),
    ),
    publishedBy: nullable(uuidSchema()),
    instructions: nullable({
      type: 'object',
      description: 'Opaque JSON instructions payload.',
    }),
    referenceImages: nullable({
      type: 'object',
      description: 'Opaque JSON reference-image payload.',
    }),
    createdAt: isoDateTimeSchema(),
    lines: {
      type: 'array',
      items: recipeLineSchema,
      description: 'Present only where the endpoint populates line snapshots.',
    },
  },
};

const recipeSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    scope: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    brandId: nullable(uuidSchema()),
    branchId: nullable(uuidSchema()),
    recipeType: {
      type: 'string',
      enum: ['menu_item', 'sub_recipe', 'production_item'],
    },
    menuItemVariantId: nullable(uuidSchema()),
    stockItemId: nullable(uuidSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

const substituteGroupSchema = {
  type: 'object',
  properties: { id: uuidSchema(), name: { type: 'string' } },
};

// Raw `substituteGroup.findMany` row (`listGroups`) — not run through
// `toGroupView`, so it also carries `tenantId` and the member list.
const substituteGroupRowSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    name: { type: 'string' },
    members: {
      type: 'array',
      items: { type: 'object', properties: { stockItemId: uuidSchema() } },
    },
  },
};

// Raw `substituteGroupMember.create` row (`addGroupMember`).
const substituteGroupMemberSchema = {
  type: 'object',
  properties: {
    tenantId: uuidSchema(),
    substituteGroupId: uuidSchema(),
    stockItemId: uuidSchema(),
  },
};

const completenessReportSchema = {
  type: 'object',
  properties: {
    branchId: nullable(
      uuidSchema(
        'The branch this report was resolved for; null for the tenant-wide view.',
      ),
    ),
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          menuItemId: uuidSchema(),
          variantId: uuidSchema(),
          reason: {
            type: 'string',
            enum: ['absent_recipe', 'incomplete_recipe'],
          },
          recipeVersionId: nullable(
            uuidSchema(
              'The incomplete published version; null for absent_recipe.',
            ),
          ),
          detail: {
            type: 'array',
            items: { type: 'string' },
            description: 'Empty for absent_recipe.',
          },
        },
      },
    },
    absentCount: { type: 'integer' },
    incompleteCount: { type: 'integer' },
    sellableVariantCount: {
      type: 'integer',
      description:
        'Active variants examined — the denominator of the completeness metric.',
    },
  },
};

const modifierRecipeEffectSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    modifierId: uuidSchema(),
    sequence: { type: 'integer' },
    operation: { type: 'string', enum: ['add', 'remove_all'] },
    componentType: { type: 'string', enum: ['stock_item', 'sub_recipe'] },
    stockItemId: nullable(uuidSchema()),
    subRecipeId: nullable(
      uuidSchema(
        'LOGICAL recipe identity — resolved to its published version at capture time.',
      ),
    ),
    quantity: nullable(decimalStringSchema()),
    unitId: nullable(uuidSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

@ApiTags('production')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({ description: 'Missing the required permission.' })
@ApiNotFoundResponse({ description: 'Unknown or cross-tenant resource.' })
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller()
export class ProductionController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly versions: RecipeVersionsService,
    private readonly groups: SubstituteGroupsService,
    private readonly completeness: RecipeCompletenessService,
    private readonly modifierRecipeEffects: ModifierRecipeEffectsService,
  ) {}

  // ------------------------------------------- recipes requiring completion --

  /**
   * BR-MNU-012's mandated report.
   *
   * "SHALL list the item in a 'recipes requiring completion' report" is the one
   * clause of BR-MNU-012 that is not satisfied inside the sale, so it needs a
   * surface. It is a READ of recipe state, so `recipe.view` governs it — the
   * same SRS 15.2 code the other reads use, and D-17-06's zero-invented-codes
   * rule is intact.
   *
   * `branchId` is optional because D-17-03 scopes recipes: without a branch the
   * report answers "is there any tenant-scope recipe", with one it answers
   * "which recipe actually applies here", and those legitimately differ.
   *
   * This is deliberately NOT the Catalogue completeness route: that one reports
   * the C-11 PRICING invariant, and BR-MNU-012 must never be read as weakening it.
   */
  @Get('recipes/requiring-completion')
  @AuthorizationTarget(branchFromQueryOrTenant('branchId'))
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'The BR-MNU-012 completeness report.',
    schema: completenessReportSchema,
  })
  recipesRequiringCompletion(
    @CurrentTenantContext() c: TenantContext,
    @Query() query: RecipeCompletenessQueryDto,
  ) {
    return this.completeness.report(c.tenantId, query.branchId);
  }

  // ------------------------------------------------------------ recipes --

  /** GAP-1 (Option A): the ratified recipe-creation deviation. */
  @Post('recipes')
  @AuthorizationTarget(declaredScopeFromBody('scope', 'brandId', 'branchId'))
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiCreatedResponse({
    description: 'The newly created recipe.',
    schema: recipeSchema,
  })
  async createRecipe(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateRecipeDto,
  ) {
    return toRecipeView(
      await this.recipes.create(c.tenantId, c.userId, {
        scope: dto.scope,
        brandId: dto.brandId,
        branchId: dto.branchId,
        recipeType: dto.recipeType,
        menuItemVariantId: dto.menuItemVariantId,
        stockItemId: dto.stockItemId,
      }),
    );
  }

  @Get('recipes')
  @AuthorizationTarget(
    tenantTarget(
      'Lists recipes at every scope in the tenant; the only filter is recipeType, which carries no scope.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  @ApiOperation({ summary: 'List recipes, optionally filtered by type.' })
  @ApiOkResponse({
    description: 'Recipes visible to this tenant.',
    schema: { type: 'array', items: recipeSchema },
  })
  async listRecipes(
    @CurrentTenantContext() c: TenantContext,
    @Query('recipeType') recipeType?: string,
  ) {
    const rows = await this.recipes.list(
      c.tenantId,
      recipeType === 'menu_item' ||
        recipeType === 'sub_recipe' ||
        recipeType === 'production_item'
        ? { recipeType }
        : undefined,
    );
    return rows.map(toRecipeView);
  }

  // ----------------------------------------------------------- versions --

  /** SRS §26.3 — version history. */
  @Get('recipes/:recipeId/versions')
  @AuthorizationTarget(
    resourceTarget(
      PRODUCTION_RECIPE_TARGET_RESOLVER,
      { recipeId: fromParam('recipeId') },
      'production.recipes carries scope + brand_id/branch_id (D-17-03, ck_recipe_scope).',
      'Recipe not found.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: 'Version history, newest first, each with its lines.',
    schema: { type: 'array', items: recipeVersionSchema },
  })
  async listVersions(
    @CurrentTenantContext() c: TenantContext,
    @Param('recipeId') recipeId: string,
  ) {
    const rows = await this.versions.list(c.tenantId, recipeId);
    return rows.map(toVersionView);
  }

  /**
   * SRS §26.3 — create a draft version.
   * A recipe is NEVER auto-created here (GAP-1): an unknown id is a 404.
   */
  @Post('recipes/:recipeId/versions')
  @AuthorizationTarget(
    resourceTarget(
      PRODUCTION_RECIPE_TARGET_RESOLVER,
      { recipeId: fromParam('recipeId') },
      'production.recipes carries scope + brand_id/branch_id (D-17-03, ck_recipe_scope).',
      'Recipe not found.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiCreatedResponse({
    description: 'The newly created draft version.',
    schema: recipeVersionSchema,
  })
  async createVersion(
    @CurrentTenantContext() c: TenantContext,
    @Param('recipeId') recipeId: string,
    @Body() dto: CreateRecipeVersionDto,
  ) {
    return toVersionView(
      await this.versions.createDraft(c.tenantId, c.userId, recipeId, dto),
    );
  }

  /** Replace a draft version's lines. Published versions are refused (409). */
  @Put('recipes/:recipeId/versions/:version/lines')
  @AuthorizationTarget(
    resourceTarget(
      PRODUCTION_RECIPE_TARGET_RESOLVER,
      { recipeId: fromParam('recipeId') },
      'production.recipes carries scope + brand_id/branch_id (D-17-03, ck_recipe_scope).',
      'Recipe not found.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiOkResponse({
    description:
      'The version row (raw, not the view shape) plus the new line count.',
    schema: {
      type: 'object',
      properties: {
        ...recipeVersionSchema.properties,
        lineCount: { type: 'integer' },
      },
    },
  })
  @ApiConflictResponse({
    description:
      'The version is not a draft; published versions are immutable (D-17-04).',
  })
  async replaceLines(
    @CurrentTenantContext() c: TenantContext,
    @Param('recipeId') recipeId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: ReplaceRecipeLinesDto,
  ) {
    return this.versions.replaceLines(
      c.tenantId,
      c.userId,
      recipeId,
      version,
      dto.lines,
    );
  }

  /** SRS §26.3 — publish. Demotes the incumbent, promotes the target, one txn. */
  @Post('recipes/:recipeId/versions/:version/publish')
  @AuthorizationTarget(
    resourceTarget(
      PRODUCTION_RECIPE_TARGET_RESOLVER,
      { recipeId: fromParam('recipeId') },
      'production.recipes carries scope + brand_id/branch_id (D-17-03, ck_recipe_scope).',
      'Recipe not found.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.PUBLISH)
  @ApiCreatedResponse({
    description:
      'The now-published version, plus the id of the version it superseded (if any).',
    schema: {
      type: 'object',
      properties: {
        ...recipeVersionSchema.properties,
        supersededVersionId: nullable(uuidSchema()),
      },
    },
  })
  async publish(
    @CurrentTenantContext() c: TenantContext,
    @Param('recipeId') recipeId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    const result = await this.versions.publish(
      c.tenantId,
      c.userId,
      recipeId,
      version,
    );
    return {
      ...toVersionView(result.published),
      supersededVersionId: result.supersededVersionId,
    };
  }

  // -------------------------------------------------- substitute groups --

  @Post('substitute-groups')
  @AuthorizationTarget(
    tenantTarget(
      'Substitute groups and modifier recipe effects are tenant-owned: neither table carries a brand or branch column, and both are shared by every recipe in the tenant.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiOperation({
    summary:
      'Create a substitute group, optionally seeded with member stock items.',
  })
  @ApiCreatedResponse({
    description: 'The newly created substitute group.',
    schema: substituteGroupSchema,
  })
  async createGroup(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateSubstituteGroupDto,
  ) {
    return toGroupView(
      await this.groups.create(c.tenantId, c.userId, {
        name: dto.name,
        stockItemIds: dto.stockItemIds,
      }),
    );
  }

  @Get('substitute-groups')
  @AuthorizationTarget(
    tenantTarget(
      'Substitute groups and modifier recipe effects are tenant-owned: neither table carries a brand or branch column, and both are shared by every recipe in the tenant.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  @ApiOperation({ summary: 'List substitute groups.' })
  @ApiOkResponse({
    description: 'Substitute groups with their member stock items.',
    schema: { type: 'array', items: substituteGroupRowSchema },
  })
  listGroups(@CurrentTenantContext() c: TenantContext) {
    return this.groups.list(c.tenantId);
  }

  @Post('substitute-groups/:groupId/members')
  @AuthorizationTarget(
    tenantTarget(
      'Substitute groups and modifier recipe effects are tenant-owned: neither table carries a brand or branch column, and both are shared by every recipe in the tenant.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiOperation({ summary: 'Add a stock item to a substitute group.' })
  @ApiCreatedResponse({
    description: 'The newly created membership row.',
    schema: substituteGroupMemberSchema,
  })
  addGroupMember(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') groupId: string,
    @Body() dto: AddSubstituteMemberDto,
  ) {
    return this.groups.addMember(
      c.tenantId,
      c.userId,
      groupId,
      dto.stockItemId,
    );
  }

  // ------------------------------------------- modifier recipe effects --

  /** D-17-07 resolution — the pinned-at-capture-time recipe effects for a Modifier. */
  @Get('modifiers/:modifierId/recipe-effects')
  @AuthorizationTarget(
    tenantTarget(
      'Substitute groups and modifier recipe effects are tenant-owned: neither table carries a brand or branch column, and both are shared by every recipe in the tenant.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  @ApiOkResponse({
    description: "The modifier's recipe effects, in sequence order.",
    schema: { type: 'array', items: modifierRecipeEffectSchema },
  })
  listModifierRecipeEffects(
    @CurrentTenantContext() c: TenantContext,
    @Param('modifierId') modifierId: string,
  ) {
    return this.modifierRecipeEffects.list(c.tenantId, modifierId);
  }

  /** Full replace, shaped like `PUT /recipes/:id/versions/:v/lines`. */
  @Put('modifiers/:modifierId/recipe-effects')
  @AuthorizationTarget(
    tenantTarget(
      'Substitute groups and modifier recipe effects are tenant-owned: neither table carries a brand or branch column, and both are shared by every recipe in the tenant.',
    ),
  )
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
  @ApiOkResponse({
    description: 'The replaced set of recipe effects.',
    schema: {
      type: 'object',
      properties: {
        modifierId: uuidSchema(),
        effects: { type: 'array', items: modifierRecipeEffectSchema },
      },
    },
  })
  replaceModifierRecipeEffects(
    @CurrentTenantContext() c: TenantContext,
    @Param('modifierId') modifierId: string,
    @Body() dto: ReplaceModifierRecipeEffectsDto,
  ) {
    return this.modifierRecipeEffects.replace(
      c.tenantId,
      c.userId,
      modifierId,
      dto.effects,
    );
  }
}
