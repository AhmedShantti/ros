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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
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
  ReplaceRecipeLinesDto,
} from './production.dto';
import { PRODUCTION_PERMISSIONS } from './production.permissions';
import { RecipeCompletenessService } from './costing/recipe-completeness.service';
import { RecipesService } from './recipes/recipes.service';
import { SubstituteGroupsService } from './substitute-groups/substitute-groups.service';
import { RecipeVersionsService } from './versions/recipe-versions.service';
import { toRecipeView, toVersionView, toGroupView } from './production.views';

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
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  recipesRequiringCompletion(
    @CurrentTenantContext() c: TenantContext,
    @Query() query: RecipeCompletenessQueryDto,
  ) {
    return this.completeness.report(c.tenantId, query.branchId);
  }

  // ------------------------------------------------------------ recipes --

  /** GAP-1 (Option A): the ratified recipe-creation deviation. */
  @Post('recipes')
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.PUBLISH)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
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
  @RequirePermission(PRODUCTION_PERMISSIONS.VIEW)
  listGroups(@CurrentTenantContext() c: TenantContext) {
    return this.groups.list(c.tenantId);
  }

  @Post('substitute-groups/:groupId/members')
  @RequirePermission(PRODUCTION_PERMISSIONS.EDIT)
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
}
