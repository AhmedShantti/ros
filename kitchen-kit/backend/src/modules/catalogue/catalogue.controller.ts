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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  isoDateTimeSchema,
  moneyStringSchema,
  decimalStringSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
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
import {
  AuthorizationTarget,
  branchFromBody,
  branchFromBodyOrTenant,
  branchFromParam,
  declaredScopeFromBody,
  fromParam,
  resourceTarget,
  tenantTarget,
} from '../identity/contract';
import {
  CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER,
  CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
} from './contract';

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

// Shapes verified against `catalogue.views.ts` — the only place these
// responses are actually built — not against the Prisma schema or the SRS.
const localizedTextSchema = {
  type: 'object',
  description: 'Localised text, e.g. {"ar": "...", "en": "..."}.',
};

const menuSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: localizedTextSchema,
    orderTypes: { type: 'array', items: { type: 'string' } },
    activeWindow: nullable({
      type: 'object',
      description:
        'Opaque time-window configuration (FR-MNU-002); this phase does not evaluate it.',
    }),
    priority: { type: 'integer' },
    isActive: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
  },
};

const categorySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    menuId: uuidSchema(),
    parentCategoryId: nullable(uuidSchema()),
    name: localizedTextSchema,
    sortOrder: { type: 'integer' },
    colour: nullable({ type: 'string', example: '#FF5733' }),
  },
};

const menuItemSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    names: localizedTextSchema,
    kitchenNames: localizedTextSchema,
    aggregatorNames: localizedTextSchema,
    description: nullable(localizedTextSchema),
    taxClassId: nullable(uuidSchema()),
    revenueAccountCode: nullable({ type: 'string' }),
    barcodePlu: nullable({ type: 'string' }),
    allergens: { type: 'array', items: { type: 'string' } },
    dietaryTags: { type: 'array', items: { type: 'string' } },
    sortOrder: { type: 'integer' },
    colour: nullable({ type: 'string', example: '#FF5733' }),
    isCombo: {
      type: 'boolean',
      description:
        'Retained per FR-MNU-004; no Combo tables exist (C-08) — always false in practice.',
    },
    isOpenPrice: { type: 'boolean' },
    isWeighed: { type: 'boolean' },
    isActive: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
  },
};

const variantSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    menuItemId: uuidSchema(),
    name: localizedTextSchema,
    barcode: nullable({ type: 'string' }),
    prepTimeSeconds: nullable({ type: 'integer' }),
    sortOrder: { type: 'integer' },
    isActive: { type: 'boolean' },
  },
};

const modifierGroupSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: localizedTextSchema,
    minSelections: { type: 'integer' },
    maxSelections: { type: 'integer' },
    isRequired: { type: 'boolean' },
    allowRepeat: { type: 'boolean' },
    freeQuantityThreshold: {
      type: 'integer',
      description: 'FR-MNU-011 "first N free, rest charged".',
    },
  },
};

const modifierSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    modifierGroupId: uuidSchema(),
    name: localizedTextSchema,
    kind: nullable({
      type: 'string',
      enum: ['addition', 'removal', 'substitution'],
      description:
        'FR-POS-021. null on a legacy modifier with no non-heuristic source for its kind.',
    }),
    priceDelta: moneyStringSchema(
      'Minor-unit money delta; may be negative (e.g. a substitution credit).',
    ),
    stockItemId: nullable(uuidSchema()),
    consumptionQuantity: nullable(decimalStringSchema()),
    consumptionUnitId: nullable(uuidSchema()),
    recipeDelta: nullable({
      type: 'object',
      description:
        'Opaque; not interpreted or executed by this phase (FR-MNU-013).',
    }),
    isDefault: { type: 'boolean' },
    sortOrder: { type: 'integer' },
  },
};

const priceListSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: { type: 'string' },
    scopeType: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    scopeId: nullable(uuidSchema()),
    orderType: nullable({ type: 'string' }),
    validFrom: nullable(isoDateTimeSchema()),
    validTo: nullable(isoDateTimeSchema()),
    recurrenceRule: nullable({
      type: 'object',
      description:
        'Opaque recurrence configuration (FR-MNU-022); not evaluated by this phase.',
    }),
    priority: { type: 'integer' },
    status: { type: 'string', example: 'scheduled' },
  },
};

const priceEntrySchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    priceListId: uuidSchema(),
    menuItemVariantId: uuidSchema(),
    price: moneyStringSchema(),
    currency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
  },
};

const availabilityRuleSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    menuItemId: nullable(uuidSchema()),
    variantId: nullable(uuidSchema()),
    branchId: nullable(uuidSchema('null applies to all branches.')),
    channel: nullable({ type: 'string' }),
    dayOfWeek: nullable({ type: 'integer' }),
    startsAt: nullable({
      type: 'string',
      description: 'Time of day (no date component).',
      example: '11:00:00',
    }),
    endsAt: nullable({
      type: 'string',
      description: 'Time of day (no date component).',
      example: '23:00:00',
    }),
    isManual86: { type: 'boolean' },
    autoReenableAt: nullable(isoDateTimeSchema()),
  },
};

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
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created menu.',
    schema: menuSchema,
  })
  createMenu(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateMenuDto,
  ) {
    return this.menus.create(c.tenantId, c.userId, dto);
  }

  @Get('menus')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'All menus for this tenant.',
    schema: { type: 'array', items: menuSchema },
  })
  listMenus(@CurrentTenantContext() c: TenantContext) {
    return this.menus.list(c.tenantId);
  }

  @Get('menus/:menuId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({ description: 'The menu.', schema: menuSchema })
  @ApiNotFoundResponse({ description: 'Menu not found.' })
  getMenu(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
  ) {
    return this.menus.findOne(c.tenantId, id);
  }

  @Patch('menus/:menuId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ description: 'The updated menu.', schema: menuSchema })
  @ApiNotFoundResponse({ description: 'Menu not found.' })
  updateMenu(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: UpdateMenuDto,
  ) {
    return this.menus.update(c.tenantId, c.userId, id, dto);
  }

  @Post('menus/:menuId/status')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({
    summary: 'Activate/deactivate a menu (C-09 explicit, audited lifecycle).',
  })
  @ApiCreatedResponse({ description: 'The updated menu.', schema: menuSchema })
  @ApiNotFoundResponse({ description: 'Menu not found.' })
  setMenuActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.menus.setActive(c.tenantId, c.userId, id, dto.isActive);
  }

  // C-01 — FR-MNU-002 branch assignment
  @Post('menus/:menuId/branches')
  @AuthorizationTarget(branchFromBody('branchId'))
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({ summary: 'Assign a menu to a branch (C-01).' })
  @ApiNoContentResponse({ description: 'Assigned.' })
  @ApiNotFoundResponse({ description: 'Menu or branch not found.' })
  @ApiConflictResponse({
    description: 'This menu is already assigned to that branch.',
  })
  async assignBranch(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Body() dto: AssignBranchDto,
  ): Promise<void> {
    await this.menus.assignBranch(c.tenantId, c.userId, id, dto.branchId);
  }

  @Delete('menus/:menuId/branches/:branchId')
  @AuthorizationTarget(branchFromParam('branchId'))
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiNoContentResponse({ description: 'Unassigned.' })
  @ApiNotFoundResponse({ description: 'Menu branch assignment not found.' })
  async unassignBranch(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
    @Param('branchId') branchId: string,
  ): Promise<void> {
    await this.menus.unassignBranch(c.tenantId, c.userId, id, branchId);
  }

  @Get('menus/:menuId/branches')
  @AuthorizationTarget(
    tenantTarget(
      'Lists every branch a tenant-owned menu is assigned to; the answer spans the tenant.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'Branch ids this menu is assigned to.',
    schema: { type: 'array', items: { type: 'string', format: 'uuid' } },
  })
  listMenuBranches(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') id: string,
  ) {
    return this.menus.listBranches(c.tenantId, id);
  }

  /** FR-MNU-003: priority-ordered resolution with an ambiguity warning. */
  @Get('branches/:branchId/menus')
  @ApiNotFoundResponse({
    description:
      'The named branch is not visible in this tenant — unknown, or another ' +
      "tenant's. Byte-identical for both, so a caller cannot learn that a " +
      'foreign branch exists.',
  })
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description:
      'Active menus assigned to this branch, priority order (highest first).',
    schema: {
      type: 'object',
      properties: {
        menus: { type: 'array', items: menuSchema },
        ambiguous: {
          type: 'boolean',
          description:
            'True when two or more menus share the same priority — resolution order is then not deterministic.',
        },
        warning: {
          type: 'string',
          description: 'Present only when ambiguous is true.',
        },
      },
    },
  })
  resolveMenus(
    @CurrentTenantContext() c: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.menus.resolveForBranch(c.tenantId, branchId);
  }

  // ------------------------------------------------------------ categories --
  @Post('menus/:menuId/categories')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created category.',
    schema: categorySchema,
  })
  @ApiNotFoundResponse({ description: 'Menu or parent category not found.' })
  createCategory(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') menuId: string,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.categories.create(c.tenantId, c.userId, menuId, dto);
  }

  @Get('menus/:menuId/categories')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'Categories on this menu, sort order.',
    schema: { type: 'array', items: categorySchema },
  })
  @ApiNotFoundResponse({ description: 'Menu not found.' })
  listCategories(
    @CurrentTenantContext() c: TenantContext,
    @Param('menuId') menuId: string,
  ) {
    return this.categories.listForMenu(c.tenantId, menuId);
  }

  @Patch('categories/:categoryId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({
    description: 'The updated category.',
    schema: categorySchema,
  })
  @ApiNotFoundResponse({
    description: 'Category, or new parent category, not found.',
  })
  updateCategory(
    @CurrentTenantContext() c: TenantContext,
    @Param('categoryId') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(c.tenantId, c.userId, id, dto);
  }

  // ------------------------------------------------------------ menu items --
  @Post('items')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created menu item.',
    schema: menuItemSchema,
  })
  createItem(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateMenuItemDto,
  ) {
    return this.items.create(c.tenantId, c.userId, dto);
  }

  @Get('items')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'All menu items for this tenant.',
    schema: { type: 'array', items: menuItemSchema },
  })
  listItems(@CurrentTenantContext() c: TenantContext) {
    return this.items.list(c.tenantId);
  }

  @Get('items/:itemId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({ description: 'The menu item.', schema: menuItemSchema })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  getItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.findOne(c.tenantId, id);
  }

  @Patch('items/:itemId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({
    description: 'The updated menu item.',
    schema: menuItemSchema,
  })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  updateItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.items.update(c.tenantId, c.userId, id, dto);
  }

  @Post('items/:itemId/status')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({
    summary:
      'Activate/deactivate a menu item (C-09 explicit, audited lifecycle).',
  })
  @ApiCreatedResponse({
    description: 'The updated menu item.',
    schema: menuItemSchema,
  })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  setItemActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.items.setActive(c.tenantId, c.userId, id, dto.isActive);
  }

  // C-02 — placement, so one item may appear on many menus
  @Post('items/:itemId/placements')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({
    summary:
      'Place an item into a category (C-02) — an item may be placed in many categories.',
  })
  @ApiNoContentResponse({ description: 'Placed.' })
  @ApiNotFoundResponse({ description: 'Menu item or category not found.' })
  @ApiConflictResponse({
    description: 'This item is already placed in that category.',
  })
  async placeItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: PlaceMenuItemDto,
  ): Promise<void> {
    await this.items.place(c.tenantId, c.userId, id, dto.categoryId);
  }

  @Delete('items/:itemId/placements/:categoryId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiNoContentResponse({ description: 'Unplaced.' })
  @ApiNotFoundResponse({ description: 'Placement not found.' })
  async unplaceItem(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Param('categoryId') categoryId: string,
  ): Promise<void> {
    await this.items.unplace(c.tenantId, c.userId, id, categoryId);
  }

  @Get('items/:itemId/placements')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'Categories (and their menus) this item is placed in.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { categoryId: uuidSchema(), menuId: uuidSchema() },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  listPlacements(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.listPlacements(c.tenantId, id);
  }

  @Post('items/:itemId/variants')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created variant.',
    schema: variantSchema,
  })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  @ApiConflictResponse({
    description:
      'This variant defaults to active and would leave an active price list without a price for it (C-11 amended).',
  })
  addVariant(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.items.addVariant(c.tenantId, c.userId, id, dto);
  }

  @Get('items/:itemId/variants')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'Variants of this item, sort order.',
    schema: { type: 'array', items: variantSchema },
  })
  @ApiNotFoundResponse({ description: 'Menu item not found.' })
  listVariants(
    @CurrentTenantContext() c: TenantContext,
    @Param('itemId') id: string,
  ) {
    return this.items.listVariants(c.tenantId, id);
  }

  @Post('variants/:variantId/status')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({
    summary:
      'Activate/deactivate a variant (C-09 explicit, audited lifecycle).',
  })
  @ApiCreatedResponse({
    description: 'The updated variant.',
    schema: variantSchema,
  })
  @ApiNotFoundResponse({ description: 'Variant not found.' })
  @ApiConflictResponse({
    description:
      'Activating would leave an active price list without a price for this variant (C-11 amended).',
  })
  setVariantActive(
    @CurrentTenantContext() c: TenantContext,
    @Param('variantId') id: string,
    @Body() dto: SetActiveDto,
  ) {
    return this.items.setVariantActive(c.tenantId, c.userId, id, dto.isActive);
  }

  @Post('items/:itemId/modifier-groups')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOperation({
    summary:
      'Attach a reusable modifier group to an item, with optional per-item overrides (FR-MNU-010).',
  })
  @ApiNoContentResponse({ description: 'Linked.' })
  @ApiNotFoundResponse({
    description: 'Menu item or modifier group not found.',
  })
  @ApiConflictResponse({
    description: 'This modifier group is already linked to the item.',
  })
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
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created modifier group.',
    schema: modifierGroupSchema,
  })
  @ApiBadRequestResponse({
    description: 'min > max, or isRequired with min < 1 (SRS §7.3 #8).',
  })
  createModifierGroup(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateModifierGroupDto,
  ) {
    return this.modifierGroups.create(c.tenantId, c.userId, dto);
  }

  @Get('modifier-groups')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'All modifier groups for this tenant.',
    schema: { type: 'array', items: modifierGroupSchema },
  })
  listModifierGroups(@CurrentTenantContext() c: TenantContext) {
    return this.modifierGroups.list(c.tenantId);
  }

  @Patch('modifier-groups/:groupId')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({
    description: 'The updated modifier group.',
    schema: modifierGroupSchema,
  })
  @ApiNotFoundResponse({ description: 'Modifier group not found.' })
  @ApiBadRequestResponse({
    description: 'min > max, or isRequired with min < 1 (SRS §7.3 #8).',
  })
  updateModifierGroup(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
    @Body() dto: UpdateModifierGroupDto,
  ) {
    return this.modifierGroups.update(c.tenantId, c.userId, id, dto);
  }

  @Post('modifier-groups/:groupId/modifiers')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created modifier.',
    schema: modifierSchema,
  })
  @ApiNotFoundResponse({ description: 'Modifier group not found.' })
  @ApiBadRequestResponse({
    description: 'priceDelta must be an integer string.',
  })
  addModifier(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
    @Body() dto: CreateModifierDto,
  ) {
    return this.modifierGroups.addModifier(c.tenantId, c.userId, id, dto);
  }

  @Get('modifier-groups/:groupId/modifiers')
  @AuthorizationTarget(
    tenantTarget(
      'Menu/catalogue master data is tenant-owned: `catalogue.menus`, `menu_items`, `menu_item_variants`, `menu_categories` and `modifier_groups` carry no branch column. Applicability to a branch is expressed by the SEPARATE menu-branch assignment, which is branch-targeted in its own right.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description: 'Modifiers in this group, sort order.',
    schema: { type: 'array', items: modifierSchema },
  })
  @ApiNotFoundResponse({ description: 'Modifier group not found.' })
  listModifiers(
    @CurrentTenantContext() c: TenantContext,
    @Param('groupId') id: string,
  ) {
    return this.modifierGroups.listModifiers(c.tenantId, id);
  }

  // ------------------------------------------------------------ price list --
  @Post('price-lists')
  @AuthorizationTarget(declaredScopeFromBody('scopeType', 'scopeId', 'scopeId'))
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_CHANGE)
  @ApiCreatedResponse({
    description: 'The newly created price list.',
    schema: priceListSchema,
  })
  @ApiBadRequestResponse({
    description: 'Invalid scopeId for the given scopeType.',
  })
  @ApiNotFoundResponse({
    description: 'Brand or branch (named by scopeId) not found.',
  })
  @ApiConflictResponse({
    description:
      'Another price list already covers this scope at this priority for an overlapping validity window (SRS §7.3 #10), or (created as active) it is incomplete (C-11 amended).',
  })
  createPriceList(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreatePriceListDto,
  ) {
    return this.priceLists.create(c.tenantId, c.userId, dto);
  }

  @Get('price-lists')
  @AuthorizationTarget(
    tenantTarget('Lists every price list in the tenant, at every scope.'),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  @ApiOkResponse({
    description: 'All price lists for this tenant, priority descending.',
    schema: { type: 'array', items: priceListSchema },
  })
  listPriceLists(@CurrentTenantContext() c: TenantContext) {
    return this.priceLists.list(c.tenantId);
  }

  @Get('price-lists/:priceListId')
  @AuthorizationTarget(
    resourceTarget(
      CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
      { priceListId: fromParam('priceListId') },
      'catalogue.price_lists carries its own scope_type + scope_id.',
      'Price list not found.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  @ApiOkResponse({ description: 'The price list.', schema: priceListSchema })
  @ApiNotFoundResponse({ description: 'Price list not found.' })
  getPriceList(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
  ) {
    return this.priceLists.findOne(c.tenantId, id);
  }

  @Post('price-lists/:priceListId/entries')
  @AuthorizationTarget(
    resourceTarget(
      CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
      { priceListId: fromParam('priceListId') },
      'catalogue.price_lists carries its own scope_type + scope_id.',
      'Price list not found.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_CHANGE)
  @ApiOperation({
    summary:
      "Set (create or overwrite) a variant's price within this list (FR-MNU-023/024).",
  })
  @ApiCreatedResponse({
    description: 'The saved price entry.',
    schema: priceEntrySchema,
  })
  @ApiBadRequestResponse({
    description: 'price must be an integer string in minor currency units.',
  })
  @ApiNotFoundResponse({ description: 'Price list or variant not found.' })
  setPriceEntry(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
    @Body() dto: SetPriceEntryDto,
  ) {
    return this.priceLists.setPriceEntry(c.tenantId, c.userId, id, dto);
  }

  @Get('price-lists/:priceListId/entries')
  @AuthorizationTarget(
    resourceTarget(
      CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
      { priceListId: fromParam('priceListId') },
      'catalogue.price_lists carries its own scope_type + scope_id.',
      'Price list not found.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.PRICE_READ)
  @ApiOkResponse({
    description: 'Price entries in this list.',
    schema: { type: 'array', items: priceEntrySchema },
  })
  @ApiNotFoundResponse({ description: 'Price list not found.' })
  listPriceEntries(
    @CurrentTenantContext() c: TenantContext,
    @Param('priceListId') id: string,
  ) {
    return this.priceLists.listEntries(c.tenantId, id);
  }

  // ----------------------------------------------------------- availability --
  @Post('availability-rules')
  @AuthorizationTarget(branchFromBodyOrTenant('branchId'))
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_TOGGLE)
  @ApiCreatedResponse({
    description: 'The newly created availability rule.',
    schema: availabilityRuleSchema,
  })
  @ApiBadRequestResponse({
    description: 'A rule must target exactly one of menuItemId or variantId.',
  })
  @ApiNotFoundResponse({
    description: 'Menu item, variant, or branch not found.',
  })
  createAvailabilityRule(
    @CurrentTenantContext() c: TenantContext,
    @Body() dto: CreateAvailabilityRuleDto,
  ) {
    return this.availability.createRule(c.tenantId, c.userId, dto);
  }

  @Get('availability-rules')
  @AuthorizationTarget(
    tenantTarget(
      'Lists availability rules across the tenant; the only filter is menuItemId, which carries no scope.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_READ)
  @ApiOkResponse({
    description: 'Availability rules, optionally filtered to one menu item.',
    schema: { type: 'array', items: availabilityRuleSchema },
  })
  listAvailabilityRules(
    @CurrentTenantContext() c: TenantContext,
    @Query('menuItemId') menuItemId?: string,
  ) {
    return this.availability.list(c.tenantId, menuItemId);
  }

  /** FR-MNU-030/032: manual 86 and authorised override, both audited. */
  @Post('availability-rules/:ruleId/86')
  @AuthorizationTarget(
    resourceTarget(
      CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER,
      { ruleId: fromParam('ruleId') },
      "The rule's own branch_id; NULL means every branch, which is a TENANT target (FR-MNU-030).",
      'Availability rule not found.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.AVAILABILITY_TOGGLE)
  @ApiCreatedResponse({
    description: 'The updated availability rule.',
    schema: availabilityRuleSchema,
  })
  @ApiNotFoundResponse({ description: 'Availability rule not found.' })
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
  @AuthorizationTarget(
    tenantTarget(
      'A tenant-wide catalogue completeness report over tenant-owned master data.',
    ),
  )
  @RequirePermission(CATALOGUE_PERMISSIONS.ITEM_READ)
  @ApiOkResponse({
    description:
      'C-11 (amended) completeness report: what would block sellability, without blocking anything itself.',
    schema: {
      type: 'object',
      properties: {
        itemsWithoutActiveVariant: {
          type: 'array',
          items: uuidSchema(),
          description: 'Active menu item ids with zero active variants.',
        },
        unpricedVariants: {
          type: 'array',
          items: {
            type: 'object',
            properties: { variantId: uuidSchema(), menuItemId: uuidSchema() },
          },
          description: 'Active variants with no price entry in any price list.',
        },
        activeListGaps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              priceListId: uuidSchema(),
              priceListName: { type: 'string' },
              menuItemVariantId: uuidSchema(),
            },
          },
          description:
            '(active price list x active variant) pairs lacking a price — the exact SRS §7.3 #7 invariant.',
        },
        sellable: { type: 'boolean' },
      },
    },
  })
  completenessReport(@CurrentTenantContext() c: TenantContext) {
    return this.completeness.report(c.tenantId);
  }
}
