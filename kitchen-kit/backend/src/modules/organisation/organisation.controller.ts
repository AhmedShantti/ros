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
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  createBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateBrandDto,
  ) {
    return this.brands.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('brands')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  listBrands(@CurrentTenantContext() ctx: TenantContext) {
    return this.brands.list(ctx.tenantId);
  }

  @Get('brands/:brandId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  getBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('brandId') brandId: string,
  ) {
    return this.brands.findOne(ctx.tenantId, brandId);
  }

  @Patch('brands/:brandId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  updateBrand(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('brandId') brandId: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brands.update(ctx.tenantId, ctx.userId, brandId, dto);
  }

  // ----------------------------- Branches ----------------------------------
  @Post('branches')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateBranchDto,
  ) {
    return this.branches.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('branches')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listBranches(@CurrentTenantContext() ctx: TenantContext) {
    return this.branches.list(ctx.tenantId);
  }

  @Get('branches/:branchId')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  getBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.branches.findOne(ctx.tenantId, branchId);
  }

  @Patch('branches/:branchId')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  updateBranch(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branches.update(ctx.tenantId, ctx.userId, branchId, dto);
  }

  /** Explicit status transition (D-03) — never a generic PATCH field. */
  @Post('branches/:branchId/status')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
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
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
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
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  createWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateWarehouseDto,
  ) {
    return this.warehouses.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('warehouses')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  listWarehouses(@CurrentTenantContext() ctx: TenantContext) {
    return this.warehouses.list(ctx.tenantId);
  }

  @Get('warehouses/:warehouseId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  getWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('warehouseId') warehouseId: string,
  ) {
    return this.warehouses.findOne(ctx.tenantId, warehouseId);
  }

  @Patch('warehouses/:warehouseId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  updateWarehouse(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('warehouseId') warehouseId: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehouses.update(ctx.tenantId, ctx.userId, warehouseId, dto);
  }

  // ----------------------------- Central kitchens (tenant-level) -----------
  @Post('central-kitchens')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  createCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Body() dto: CreateCentralKitchenDto,
  ) {
    return this.centralKitchens.create(ctx.tenantId, ctx.userId, dto);
  }

  @Get('central-kitchens')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  listCentralKitchens(@CurrentTenantContext() ctx: TenantContext) {
    return this.centralKitchens.list(ctx.tenantId);
  }

  @Get('central-kitchens/:centralKitchenId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_READ)
  getCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('centralKitchenId') id: string,
  ) {
    return this.centralKitchens.findOne(ctx.tenantId, id);
  }

  @Patch('central-kitchens/:centralKitchenId')
  @RequirePermission(ORGANISATION_PERMISSIONS.TENANT_MANAGE)
  updateCentralKitchen(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('centralKitchenId') id: string,
    @Body() dto: UpdateCentralKitchenDto,
  ) {
    return this.centralKitchens.update(ctx.tenantId, ctx.userId, id, dto);
  }

  // ----------------------------- Stations ----------------------------------
  @Post('branches/:branchId/stations')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateStationDto,
  ) {
    return this.stations.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/stations')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listStations(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.stations.listForBranch(ctx.tenantId, branchId);
  }

  @Get('stations/:stationId')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  getStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('stationId') stationId: string,
  ) {
    return this.stations.findOne(ctx.tenantId, stationId);
  }

  @Patch('stations/:stationId')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  updateStation(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('stationId') stationId: string,
    @Body() dto: UpdateStationDto,
  ) {
    return this.stations.update(ctx.tenantId, ctx.userId, stationId, dto);
  }

  // ----------------------------- Tables ------------------------------------
  @Post('branches/:branchId/tables')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createTable(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateTableDto,
  ) {
    return this.tables.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/tables')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listTables(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.tables.listForBranch(ctx.tenantId, branchId);
  }

  @Patch('tables/:tableId')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  updateTable(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('tableId') tableId: string,
    @Body() dto: UpdateTableDto,
  ) {
    return this.tables.update(ctx.tenantId, ctx.userId, tableId, dto);
  }

  // ----------------------------- Operating hours ---------------------------
  @Post('branches/:branchId/operating-hours')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createOperatingHours(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateOperatingHoursDto,
  ) {
    return this.operatingHours.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/operating-hours')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listOperatingHours(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.operatingHours.listForBranch(ctx.tenantId, branchId);
  }

  // ----------------------------- Print routing -----------------------------
  @Post('branches/:branchId/print-routing')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createPrintRouting(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreatePrintRoutingDto,
  ) {
    return this.printRouting.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/print-routing')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listPrintRouting(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.printRouting.listForBranch(ctx.tenantId, branchId);
  }

  // ----------------------------- Station routing ---------------------------
  @Post('branches/:branchId/station-routing-rules')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_MANAGE)
  createStationRoutingRule(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
    @Body() dto: CreateStationRoutingRuleDto,
  ) {
    return this.stationRouting.create(ctx.tenantId, ctx.userId, branchId, dto);
  }

  @Get('branches/:branchId/station-routing-rules')
  @RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)
  listStationRoutingRules(
    @CurrentTenantContext() ctx: TenantContext,
    @Param('branchId') branchId: string,
  ) {
    return this.stationRouting.listForBranch(ctx.tenantId, branchId);
  }
}
