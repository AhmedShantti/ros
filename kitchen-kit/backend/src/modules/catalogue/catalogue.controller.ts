import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { AvailabilityService } from './availability/availability.service';
import { CatalogueCompletenessService } from './catalogue-completeness.service';
import { CATALOGUE_PERMISSIONS } from './catalogue.permissions';
import {
  AssignBranchDto,
  CreateAvailabilityRuleDto,
  CreateCategoryDto,
  CreateMenuDto,
  CreateMenuItemDto,
  CreateModifierDto,
  CreateModifierGroupDto,
  CreatePriceListDto,
  CreateVariantDto,
  LinkModifierGroupDto,
  PlaceMenuItemDto,
  SetActiveDto,
  SetPriceEntryDto,
  Toggle86Dto,
  UpdateCategoryDto,
  UpdateMenuDto,
  UpdateMenuItemDto,
  UpdateModifierGroupDto,
} from './catalogue.dto';
import { CategoriesService } from './categories/categories.service';
import { MenuItemsService } from './menu-items/menu-items.service';
import { MenusService } from './menus/menus.service';
import { ModifierGroupsService } from './modifier-groups/modifier-groups.service';
import { PriceListsService } from './price-lists/price-lists.service';

/**
 * Catalogue API (Phase 16).
 *
 * Guard chain unchanged: JwtAuthGuard (401) → TenantContextGuard (403) →
 * PermissionGuard (403). Authorization is TENANT-scoped; ADR 0008 D-02's
 * deferral of branch-scoped RBAC still stands, so no handler reads
 * `TenantContext.branchId`.
 *
 * Permissions (C-05): reads require a `*.read` code and NEVER a manage code;
 * every write requires the matching manage/change/toggle code.
 *
 * No Combo endpoints exist (C-08). No `price_change_history` endpoint exists —
 * price history lives in the audit trail (C-10).
 */
@ApiTags('catalogue')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('catalogue')
export class CatalogueController {
  constructor(
    private readonly menus: MenusService,
    private readonly categories: CategoriesService,
    private readonly items: MenuItemsService,
    private readonly modifierGroups: ModifierGroupsService,
    private readonly priceLists: PriceListsService,
    private readonly availability: AvailabilityService,
    private readonly completeness: CatalogueCompletenessService,
  ) {}

  // ----------------------------------------------------------------- menus --
  @Post('menus')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  createMenu(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateMenuDto,
  ) {
    return this.menus.create(c.tenantId, c.userId, dto);
  }

  @Get('menus')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listMenus(@CurrentTenantContext() c: TenantContext) {
    return this.menus.list(c.tenantId);
  }

  @Get('menus/:menuId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  getMenu(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
  ) {
    return this.menus.findOne(c.tenantId, id);
  }

  @Patch('menus/:menuId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  updateMenu(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: UpdateMenuDto,
  ) {
    return this.menus.update(c.tenantId, c.userId, id, dto);
  }

  @Post('menus/:menuId/status')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  setMenuActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.menus.setActive(c.tenantId, c.userId, id, dto.isActive);
  }

  // C-01 — FR-MNU-002 branch assignment
  @Post('menus/:menuId/branches')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  async assignBranch(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: AssignBranchDto,
  ): Promise<void> {
    await this.menus.assignBranch(c.tenantId, c.userId, id, dto.branchId);
  }

  @Delete('menus/:menuId/branches/:branchId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  async unassignBranch(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Param('branchId') branchId: string,
  ): Promise<void> {
    await this.menus.unassignBranch(c.tenantId, c.userId, id, branchId);
  }

  @Get('menus/:menuId/branches')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listMenuBranches(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
  ) {
    return this.menus.listBranches(c.tenantId, id);
  }

  /** FR-MNU-003: priority-ordered resolution with an ambiguity warning. */
  @Get('branches/:branchId/menus')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  resolveMenus(
    @CurrentTenantContext() c: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.menus.resolveForBranch(c.tenantId, branchId);
  }

  // ------------------------------------------------------------ categories --
  @Post('menus/:menuId/categories')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  createCategory(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') menuId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categories.create(c.tenantId, c.userId, menuId, dto);
  }

  @Get('menus/:menuId/categories')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listCategories(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') menuId: string,
  ) {
    return this.categories.listForMenu(c.tenantId, menuId);
  }

  @Patch('categories/:categoryId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  updateCategory(
    @CurrentTenantContext() c: TenantContext,
    @Param('categoryId') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(c.tenantId, c.userId, id, dto);
  }

  // ------------------------------------------------------------ menu items --
  @Post('items')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  createItem(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.items.create(c.tenantId, c.userId, dto);
  }

  @Get('items')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listItems(@CurrentTenantContext() c: TenantContext) {
    return this.items.list(c.tenantId);
  }

  @Get('items/:itemId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  getItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.findOne(c.tenantId, id);
  }

  @Patch('items/:itemId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  updateItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.items.update(c.tenantId, c.userId, id, dto);
  }

  @Post('items/:itemId/status')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  setItemActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.items.setActive(c.tenantId, c.userId, id, dto.isActive);
  }

  // C-02 — placement, so one item may appear on many menus
  @Post('items/:itemId/placements')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  async placeItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: PlaceMenuItemDto,
  ): Promise<void> {
    await this.items.place(c.tenantId, c.userId, id, dto.categoryId);
  }

  @Delete('items/:itemId/placements/:categoryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  async unplaceItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Param('categoryId') categoryId: string,
  ): Promise<void> {
    await this.items.unplace(c.tenantId, c.userId, id, categoryId);
  }

  @Get('items/:itemId/placements')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listPlacements(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.listPlacements(c.tenantId, id);
  }

  @Post('items/:itemId/variants')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  addVariant(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.items.addVariant(c.tenantId, c.userId, id, dto);
  }

  @Get('items/:itemId/variants')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listVariants(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.listVariants(c.tenantId, id);
  }

  @Post('variants/:variantId/status')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  setVariantActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('variantId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.items.setVariantActive(c.tenantId, c.userId, id, dto.isActive);
  }

  @Post('items/:itemId/modifier-groups')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  async linkModifierGroup(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: LinkModifierGroupDto,
  ): Promise<void> {
    await this.items.linkModifierGroup(
      c.tenantId,
      c.userId,
      id,
      dto.modifierGroupId,
      dto,
    );
  }

  // ------------------------------------------------------- modifier groups --
  @Post('modifier-groups')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  createModifierGroup(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateModifierGroupDto,
  ) {
    return this.modifierGroups.create(c.tenantId, c.userId, dto);
  }

  @Get('modifier-groups')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listModifierGroups(@CurrentTenantContext() c: TenantContext) {
    return this.modifierGroups.list(c.tenantId);
  }

  @Patch('modifier-groups/:groupId')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  updateModifierGroup(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
    @Body() dto: UpdateModifierGroupDto,
  ) {
    return this.modifierGroups.update(c.tenantId, c.userId, id, dto);
  }

  @Post('modifier-groups/:groupId/modifiers')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  addModifier(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
    @Body() dto: CreateModifierDto,
  ) {
    return this.modifierGroups.addModifier(c.tenantId, c.userId, id, dto);
  }

  @Get('modifier-groups/:groupId/modifiers')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  listModifiers(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
  ) {
    return this.modifierGroups.listModifiers(c.tenantId, id);
  }

  // ------------------------------------------------------------ price list --
  @Post('price-lists')
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_CHANGE)
  createPriceList(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreatePriceListDto,
  ) {
    return this.priceLists.create(c.tenantId, c.userId, dto);
  }

  @Get('price-lists')
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  listPriceLists(@CurrentTenantContext() c: TenantContext) {
    return this.priceLists.list(c.tenantId);
  }

  @Get('price-lists/:priceListId')
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  getPriceList(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
  ) {
    return this.priceLists.findOne(c.tenantId, id);
  }

  @Post('price-lists/:priceListId/entries')
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_CHANGE)
  setPriceEntry(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
    @Body() dto: SetPriceEntryDto,
  ) {
    return this.priceLists.setPriceEntry(c.tenantId, c.userId, id, dto);
  }

  @Get('price-lists/:priceListId/entries')
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  listPriceEntries(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
  ) {
    return this.priceLists.listEntries(c.tenantId, id);
  }

  // ----------------------------------------------------------- availability --
  @Post('availability-rules')
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_TOGGLE)
  createAvailabilityRule(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateAvailabilityRuleDto,
  ) {
    return this.availability.createRule(c.tenantId, c.userId, dto);
  }

  @Get('availability-rules')
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_READ)
  listAvailabilityRules(
    @CurrentTenantContext() c: TenantContext,
    @Query('menuItemId') menuItemId?: string,
  ) {
    return this.availability.list(c.tenantId, menuItemId);
  }

  /** FR-MNU-030/032: manual 86 and authorised override, both audited. */
  @Post('availability-rules/:ruleId/86')
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_TOGGLE)
  toggle86(
    @CurrentTenantContext() c: TenantContext,
    @Param('ruleId') id: string,
    @Body() dto: Toggle86Dto,
  ) {
    return this.availability.toggle86(
      c.tenantId,
      c.userId,
      id,
      dto.isManual86,
      dto.autoReenableAt,
      dto.reasonText,
    );
  }

  // ------------------------------------------------------------ C-11 report --
  /** Validated business invariant, reported — never a hard write-time block. */
  @Get('completeness')
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  completenessReport(@CurrentTenantContext() c: TenantContext) {
    return this.completeness.report(c.tenantId);
  }
}
