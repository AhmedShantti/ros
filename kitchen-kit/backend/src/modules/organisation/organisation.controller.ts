import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
  isoDateTimeSchema,
  nullable,
  uuidSchema,
} from '../../common/openapi/schema-helpers';
import { JwtAuthGuard } from '../identity/auth/guards/jwt-auth.guard';
import { RequirePermission } from '../identity/authz/decorators/require-permission.decorator';
import { PermissionGuard } from '../identity/authz/guards/permission.guard';
import { CurrentTenantContext } from '../identity/context/current-tenant-context.decorator';
import type { TenantContext } from '../identity/context/tenant-context';
import { TenantContextGuard } from '../identity/context/tenant-context.guard';
import { BrandsService } from './brands/brands.service';
import { CreateBrandDto } from './brands/dto/create-brand.dto';
import { UpdateBrandDto } from './brands/dto/update-brand.dto';
import { BranchesService } from './branches/branches.service';
import { CreateBranchDto } from './branches/dto/create-branch.dto';
import { ReassignBrandDto } from './branches/dto/reassign-brand.dto';
import { SetBranchStatusDto } from './branches/dto/set-branch-status.dto';
import { UpdateBranchDto } from './branches/dto/update-branch.dto';
import { CentralKitchensService } from './central-kitchens/central-kitchens.service';
import { CreateCentralKitchenDto } from './central-kitchens/dto/create-central-kitchen.dto';
import { UpdateCentralKitchenDto } from './central-kitchens/dto/update-central-kitchen.dto';
import { CreateOperatingHoursDto } from './operating-hours/dto/create-operating-hours.dto';
import { OperatingHoursService } from './operating-hours/operating-hours.service';
import { ORGANISATION_PERMISSIONS } from './organisation.permissions';
import { CreatePrintRoutingDto } from './print-routing/dto/create-print-routing.dto';
import { PrintRoutingService } from './print-routing/print-routing.service';
import { CreateStationRoutingRuleDto } from './station-routing/dto/create-station-routing.dto';
import { StationRoutingService } from './station-routing/station-routing.service';
import { CreateStationDto } from './stations/dto/create-station.dto';
import { UpdateStationDto } from './stations/dto/update-station.dto';
import { StationsService } from './stations/stations.service';
import { CreateTableDto } from './tables/dto/create-table.dto';
import { UpdateTableDto } from './tables/dto/update-table.dto';
import { TablesService } from './tables/tables.service';
import { CreateWarehouseDto } from './warehouses/dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './warehouses/dto/update-warehouse.dto';
import { WarehousesService } from './warehouses/warehouses.service';
import {
  AuthorizationTarget,
  brandFromBody,
  brandFromParam,
  branchFromParam,
  fromParam,
  resourceTarget,
  tenantTarget,
} from '../identity/contract';
import {
  ORG_STATION_TARGET_RESOLVER,
  ORG_TABLE_TARGET_RESOLVER,
  ORG_WAREHOUSE_TARGET_RESOLVER,
} from './contract';

/**
 * Organisation configuration API (Phase 15).
 *
 * Guard chain is the established one: JwtAuthGuard (401) → TenantContextGuard
 * (403) → PermissionGuard (403). Authorization is TENANT-scoped only —
 * branch-scoped RBAC is deferred (ADR 0008 D-02), so no handler reads
 * `TenantContext.branchId` and no guard was modified.
 *
 * No DELETE endpoints exist anywhere in this controller: ADR 0008 D-12 ratified
 * that Phase 15 exposes create/read/update only.
 *
 * The tenant is always taken from the validated TenantContext; no DTO accepts a
 * tenantId, and unknown properties are rejected by the global ValidationPipe.
 */

// Shapes verified against each submodule's own `to*Summary` view function —
// `brand.view.ts`, `branch.view.ts`, `warehouse.view.ts`,
// `central-kitchen.view.ts`, `station.view.ts`, `branch-table.view.ts`,
// `operating-hours.view.ts`, `print-routing.view.ts`,
// `station-routing.view.ts` — not against the Prisma schema or the SRS.
const brandSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: { type: 'string' },
    theme: {
      type: 'object',
      description: 'Opaque brand theme JSON, as stored.',
    },
    defaultSettings: {
      type: 'object',
      description: 'Opaque default-settings JSON, as stored.',
    },
    createdAt: isoDateTimeSchema(),
  },
};

const branchSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    brandId: uuidSchema(),
    code: { type: 'string' },
    name: { type: 'string' },
    timezone: { type: 'string', example: 'Asia/Dubai' },
    baseCurrency: {
      type: 'string',
      description: 'ISO 4217 currency code.',
      example: 'AED',
    },
    countryCode: { type: 'string', example: 'AE' },
    address: { type: 'object', description: 'Opaque address JSON, as stored.' },
    status: { type: 'string', enum: ['active', 'inactive'] },
    automaticAvailability: { type: 'boolean' },
    createdAt: isoDateTimeSchema(),
  },
};

const warehouseSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: { type: 'string' },
    warehouseType: { type: 'string', enum: ['branch', 'central', 'virtual'] },
    branchId: nullable(uuidSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

const centralKitchenSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    name: { type: 'string' },
    warehouseId: uuidSchema(),
  },
};

const stationSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    name: { type: 'string' },
    capacityConfig: {
      type: 'object',
      description: 'Opaque capacity-config JSON, as stored.',
    },
    displayColour: nullable({ type: 'string' }),
    displayTerminalId: nullable(uuidSchema()),
    createdAt: isoDateTimeSchema(),
  },
};

const tableSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    label: { type: 'string' },
    section: nullable({ type: 'string' }),
    seatCapacity: nullable({ type: 'integer' }),
  },
};

const operatingHoursSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    dayOfWeek: {
      type: 'integer',
      description: '0 (Sunday) through 6 (Saturday).',
    },
    opensAt: { type: 'string', pattern: '^\\d{2}:\\d{2}$', example: '09:00' },
    closesAt: { type: 'string', pattern: '^\\d{2}:\\d{2}$', example: '23:00' },
    businessDayCutover: {
      type: 'string',
      pattern: '^\\d{2}:\\d{2}$',
      example: '05:00',
    },
    overnight: {
      type: 'boolean',
      description: 'True when the interval crosses midnight.',
    },
  },
};

const printRoutingSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    documentType: { type: 'string' },
    printerTarget: { type: 'string' },
    stationId: nullable(uuidSchema()),
  },
};

const stationRoutingRuleSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    stationId: uuidSchema(),
    menuItemId: nullable(uuidSchema()),
    categoryId: nullable(uuidSchema()),
    modifierId: nullable(uuidSchema()),
    priority: { type: 'integer' },
  },
};

@ApiTags('organisation')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing/invalid/expired token.' })
@ApiForbiddenResponse({
  description: 'No tenant context / insufficient permission.',
})
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionGuard)
@Controller('org')
export class OrganisationController {
  constructor(
    private readonly brands: BrandsService,
    private readonly branches: BranchesService,
    private readonly warehouses: WarehousesService,
    private readonly centralKitchens: CentralKitchensService,
    private readonly stations: StationsService,
    private readonly tables: TablesService,
    private readonly operatingHours: OperatingHoursService,
    private readonly printRouting: PrintRoutingService,
    private readonly stationRouting: StationRoutingService,
  ) {}

  // ----------------------------- Brands (tenant-level) ---------------------
  @Post('brands')
  @AuthorizationTarget(
    tenantTarget(
      'Creating a brand is a tenant-level act: the brand does not exist yet, so it has no owner narrower than the tenant.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created brand.',
    schema: brandSchema,
  })
  @ApiConflictResponse({
    description: 'A brand with this name already exists in the tenant.',
  })
  createBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateBrandDto,
  ) {
    return this.brands.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('brands')
  @AuthorizationTarget(
    tenantTarget(
      'Lists every brand in the tenant; the collection itself is tenant-owned.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({
    description: 'All brands in the tenant.',
    schema: { type: 'array', items: brandSchema },
  })
  listBrands(@CurrentTenantContext() ctx: TenantContext) {
    return this.brands.list(ctx.tenantId);
  }

  @Get('brands/:brandId')
  @AuthorizationTarget(brandFromParam('brandId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ description: 'The brand.', schema: brandSchema })
  @ApiNotFoundResponse({ description: 'Brand not found.' })
  getBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('brandId') brandId: string,
  ) {
    return this.brands.findOne(ctx.tenantId, brandId);
  }

  @Patch('brands/:brandId')
  @AuthorizationTarget(brandFromParam('brandId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiOkResponse({ description: 'The updated brand.', schema: brandSchema })
  @ApiNotFoundResponse({ description: 'Brand not found.' })
  @ApiConflictResponse({
    description: 'A brand with this name already exists in the tenant.',
  })
  updateBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('brandId') brandId: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brands.update(ctx.tenantId, ctx.userId, brandId, dto);
  }

  // ----------------------------- Branches ----------------------------------
  @Post('branches')
  @AuthorizationTarget(brandFromBody('brandId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created branch.',
    schema: branchSchema,
  })
  @ApiNotFoundResponse({
    description: 'The referenced brand does not exist in this tenant.',
  })
  @ApiConflictResponse({
    description: 'A branch with this code already exists in the tenant.',
  })
  createBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateBranchDto,
  ) {
    return this.branches.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('branches')
  @AuthorizationTarget(
    tenantTarget(
      'Lists every branch in the tenant; the collection itself is tenant-owned.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All branches in the tenant.',
    schema: { type: 'array', items: branchSchema },
  })
  listBranches(@CurrentTenantContext() ctx: TenantContext) {
    return this.branches.list(ctx.tenantId);
  }

  @Get('branches/:branchId')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({ description: 'The branch.', schema: branchSchema })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  getBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.branches.findOne(ctx.tenantId, branchId);
  }

  @Patch('branches/:branchId')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiOkResponse({ description: 'The updated branch.', schema: branchSchema })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  updateBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branches.update(ctx.tenantId, ctx.userId, branchId, dto);
  }

  /** Explicit status transition (D-03) — never a generic PATCH field. */
  @Post('branches/:branchId/status')
  @AuthorizationTarget(
    branchFromParam('branchId', {
      reason:
        'T-12 EXEMPTION — this route IS the branch lifecycle. A non-active ' +
        'branch is denied for every scope on every other route, and the ' +
        'operation that returns it to `active` addresses that same branch, so ' +
        'without this exemption a deactivated branch could never be ' +
        'reactivated: deactivation would be a one-way door. The exemption is ' +
        'narrow on purpose — it covers the status transition ONLY, not reading ' +
        'or editing an inactive branch, and every business operation against ' +
        'the branch stays refused until it is active again.',
    }),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiOperation({ summary: 'Set a branch active/inactive.' })
  @ApiOkResponse({ description: 'The updated branch.', schema: branchSchema })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  setBranchStatus(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: SetBranchStatusDto,
  ) {
    return this.branches.setStatus(
      ctx.tenantId,
      ctx.userId,
      branchId,
      dto.status,
    );
  }

  /**
   * FR-PLT-004 / ADR 0008 D-13 — reassign a branch between brands within the
   * same tenant. Dedicated operation with a mandatory audit record; requires the
   * tenant-level permission, and `code` is never changed.
   */
  @Post('branches/:branchId/brand')
  @AuthorizationTarget(
    tenantTarget(
      'Re-parenting a branch MOVES it between brands. A BRAND-scoped actor must not be able to move a branch into or out of its own brand, so the target is the tenant — the only scope that legitimately spans both brands.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiOperation({
    summary: 'Reassign a branch to another brand within the same tenant.',
  })
  @ApiOkResponse({ description: 'The updated branch.', schema: branchSchema })
  @ApiNotFoundResponse({
    description:
      'Branch not found, or the target brand does not exist in this tenant.',
  })
  reassignBranchBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: ReassignBrandDto,
  ) {
    return this.branches.reassignBrand(
      ctx.tenantId,
      ctx.userId,
      branchId,
      dto.brandId,
    );
  }

  // ----------------------------- Warehouses (tenant-level) -----------------
  @Post('warehouses')
  @AuthorizationTarget(
    tenantTarget(
      'The warehouse does not exist yet; `org.warehouses.branch_id` is nullable, so the operation is tenant-level (ADR 0009 D-02).',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created warehouse.',
    schema: warehouseSchema,
  })
  @ApiNotFoundResponse({ description: 'The referenced branch does not exist.' })
  @ApiConflictResponse({
    description: 'A warehouse with this name already exists in the tenant.',
  })
  createWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateWarehouseDto,
  ) {
    return this.warehouses.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('warehouses')
  @AuthorizationTarget(
    tenantTarget(
      'Lists every warehouse in the tenant, branch-owned and standalone alike.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({
    description: 'All warehouses in the tenant.',
    schema: { type: 'array', items: warehouseSchema },
  })
  listWarehouses(@CurrentTenantContext() ctx: TenantContext) {
    return this.warehouses.list(ctx.tenantId);
  }

  @Get('warehouses/:warehouseId')
  @AuthorizationTarget(
    resourceTarget(
      ORG_WAREHOUSE_TARGET_RESOLVER,
      { warehouseId: fromParam('warehouseId') },
      'BRANCH when the warehouse belongs to a branch; TENANT when it is standalone.',
      'Warehouse not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ description: 'The warehouse.', schema: warehouseSchema })
  @ApiNotFoundResponse({ description: 'Warehouse not found.' })
  getWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.warehouses.findOne(ctx.tenantId, warehouseId);
  }

  @Patch('warehouses/:warehouseId')
  @AuthorizationTarget(
    resourceTarget(
      ORG_WAREHOUSE_TARGET_RESOLVER,
      { warehouseId: fromParam('warehouseId') },
      'BRANCH when the warehouse belongs to a branch; TENANT when it is standalone.',
      'Warehouse not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiOkResponse({
    description: 'The updated warehouse.',
    schema: warehouseSchema,
  })
  @ApiNotFoundResponse({
    description:
      'Warehouse not found, or the referenced branch does not exist.',
  })
  @ApiConflictResponse({
    description: 'A warehouse with this name already exists in the tenant.',
  })
  updateWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('warehouseId') warehouseId: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehouses.update(ctx.tenantId, ctx.userId, warehouseId, dto);
  }

  // ----------------------------- Central kitchens (tenant-level) -----------
  @Post('central-kitchens')
  @AuthorizationTarget(
    tenantTarget(
      '`org.central_kitchens` is tenant-level by construction — ADR 0009 D-02 refused CENTRAL_KITCHEN as a scope type precisely because TENANT already covers it.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created central kitchen.',
    schema: centralKitchenSchema,
  })
  @ApiNotFoundResponse({ description: 'Warehouse not found.' })
  @ApiConflictResponse({
    description:
      'A central kitchen with this name, or one for this warehouse, already exists.',
  })
  createCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateCentralKitchenDto,
  ) {
    return this.centralKitchens.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('central-kitchens')
  @AuthorizationTarget(
    tenantTarget('Central kitchens are tenant-level (ADR 0009 D-02).'),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({
    description: 'All central kitchens in the tenant.',
    schema: { type: 'array', items: centralKitchenSchema },
  })
  listCentralKitchens(@CurrentTenantContext() ctx: TenantContext) {
    return this.centralKitchens.list(ctx.tenantId);
  }

  @Get('central-kitchens/:centralKitchenId')
  @AuthorizationTarget(
    tenantTarget('Central kitchens are tenant-level (ADR 0009 D-02).'),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  @ApiOkResponse({
    description: 'The central kitchen.',
    schema: centralKitchenSchema,
  })
  @ApiNotFoundResponse({ description: 'Central kitchen not found.' })
  getCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('centralKitchenId') id: string,
  ) {
    return this.centralKitchens.findOne(ctx.tenantId, id);
  }

  @Patch('central-kitchens/:centralKitchenId')
  @AuthorizationTarget(
    tenantTarget('Central kitchens are tenant-level (ADR 0009 D-02).'),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  @ApiOkResponse({
    description: 'The updated central kitchen.',
    schema: centralKitchenSchema,
  })
  @ApiNotFoundResponse({
    description: 'Central kitchen not found, or warehouse not found.',
  })
  @ApiConflictResponse({
    description:
      'A central kitchen with this name, or one for this warehouse, already exists.',
  })
  updateCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('centralKitchenId') id: string,
    @Body() dto: UpdateCentralKitchenDto,
  ) {
    return this.centralKitchens.update(ctx.tenantId, ctx.userId, id, dto);
  }

  // ----------------------------- Stations ----------------------------------
  @Post('branches/:branchId/stations')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created station.',
    schema: stationSchema,
  })
  @ApiNotFoundResponse({ description: 'Branch or display terminal not found.' })
  @ApiConflictResponse({
    description: 'A station with this name already exists in the branch.',
  })
  createStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateStationDto,
  ) {
    return this.stations.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/stations')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All stations in the branch.',
    schema: { type: 'array', items: stationSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  listStations(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.stations.listForBranch(ctx.tenantId, branchId);
  }

  @Get('stations/:stationId')
  @AuthorizationTarget(
    resourceTarget(
      ORG_STATION_TARGET_RESOLVER,
      { stationId: fromParam('stationId') },
      'A station is branch-owned and carries no tenant_id; its branch comes from the row.',
      'Station not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({ description: 'The station.', schema: stationSchema })
  @ApiNotFoundResponse({ description: 'Station not found.' })
  getStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('stationId') stationId: string,
  ) {
    return this.stations.findOne(ctx.tenantId, stationId);
  }

  @Patch('stations/:stationId')
  @AuthorizationTarget(
    resourceTarget(
      ORG_STATION_TARGET_RESOLVER,
      { stationId: fromParam('stationId') },
      'A station is branch-owned and carries no tenant_id; its branch comes from the row.',
      'Station not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiOkResponse({ description: 'The updated station.', schema: stationSchema })
  @ApiNotFoundResponse({
    description: 'Station not found, or branch/display terminal not found.',
  })
  @ApiConflictResponse({
    description: 'A station with this name already exists in the branch.',
  })
  updateStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('stationId') stationId: string,
    @Body() dto: UpdateStationDto,
  ) {
    return this.stations.update(ctx.tenantId, ctx.userId, stationId, dto);
  }

  // ----------------------------- Tables ------------------------------------
  @Post('branches/:branchId/tables')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created table.',
    schema: tableSchema,
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  @ApiConflictResponse({
    description: 'A table with this label already exists in the branch.',
  })
  createTable(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateTableDto,
  ) {
    return this.tables.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/tables')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All tables in the branch.',
    schema: { type: 'array', items: tableSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  listTables(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.tables.listForBranch(ctx.tenantId, branchId);
  }

  @Patch('tables/:tableId')
  @AuthorizationTarget(
    resourceTarget(
      ORG_TABLE_TARGET_RESOLVER,
      { tableId: fromParam('tableId') },
      'A table is branch-owned and carries no tenant_id; its branch comes from the row.',
      'Table not found.',
    ),
  )
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiOkResponse({ description: 'The updated table.', schema: tableSchema })
  @ApiNotFoundResponse({ description: 'Table not found.' })
  @ApiConflictResponse({
    description: 'A table with this label already exists in the branch.',
  })
  updateTable(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('tableId') tableId: string,
    @Body() dto: UpdateTableDto,
  ) {
    return this.tables.update(ctx.tenantId, ctx.userId, tableId, dto);
  }

  // ----------------------------- Operating hours ---------------------------
  @Post('branches/:branchId/operating-hours')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created operating-hours interval.',
    schema: operatingHoursSchema,
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  @ApiBadRequestResponse({
    description: 'The interval overlaps an existing interval for the same day.',
  })
  createOperatingHours(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateOperatingHoursDto,
  ) {
    return this.operatingHours.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/operating-hours')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All operating-hours intervals for the branch.',
    schema: { type: 'array', items: operatingHoursSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  listOperatingHours(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.operatingHours.listForBranch(ctx.tenantId, branchId);
  }

  // ----------------------------- Print routing -----------------------------
  @Post('branches/:branchId/print-routing')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created print-routing rule.',
    schema: printRoutingSchema,
  })
  @ApiNotFoundResponse({ description: 'Station not found in this branch.' })
  @ApiConflictResponse({
    description:
      'A print routing rule for this document type and station already exists.',
  })
  createPrintRouting(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreatePrintRoutingDto,
  ) {
    return this.printRouting.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/print-routing')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All print-routing rules for the branch.',
    schema: { type: 'array', items: printRoutingSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  listPrintRouting(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.printRouting.listForBranch(ctx.tenantId, branchId);
  }

  // ----------------------------- Station routing ---------------------------
  @Post('branches/:branchId/station-routing-rules')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  @ApiCreatedResponse({
    description: 'The newly created station-routing rule.',
    schema: stationRoutingRuleSchema,
  })
  @ApiNotFoundResponse({
    description: 'Station, menu item, category, or modifier not found.',
  })
  @ApiConflictResponse({
    description: 'A routing rule for this selector and station already exists.',
  })
  @ApiBadRequestResponse({
    description:
      'Exactly one of menuItemId, categoryId, or modifierId must be set.',
  })
  createStationRoutingRule(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateStationRoutingRuleDto,
  ) {
    return this.stationRouting.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/station-routing-rules')
  @AuthorizationTarget(branchFromParam('branchId'))
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  @ApiOkResponse({
    description: 'All station-routing rules for the branch.',
    schema: { type: 'array', items: stationRoutingRuleSchema },
  })
  @ApiNotFoundResponse({ description: 'Branch not found.' })
  listStationRoutingRules(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.stationRouting.listForBranch(ctx.tenantId, branchId);
  }
}
