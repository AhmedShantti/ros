import { Module, forwardRef } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { BranchCurrencyQueryService } from './branches/branch-currency.query.service';
import { BranchBrandQueryService } from './branches/branch-brand.query.service';
import { BranchReportingScopeQueryService } from './branches/branch-reporting-scope.query.service';
import { BranchesService } from './branches/branches.service';
import {
  LocationTargetResolver,
  StationTargetResolver,
  TableTargetResolver,
  WarehouseTargetResolver,
} from './branches/scope-target.resolvers';
import { BrandsService } from './brands/brands.service';
import { CentralKitchensService } from './central-kitchens/central-kitchens.service';
import {
  ORG_LOCATION_TARGET_RESOLVER,
  ORG_STATION_TARGET_RESOLVER,
  ORG_TABLE_TARGET_RESOLVER,
  ORG_WAREHOUSE_TARGET_RESOLVER,
  BRANCH_BRAND_QUERY,
  BRANCH_CURRENCY_QUERY,
  BRANCH_REPORTING_SCOPE_QUERY,
  KDS_BRANCH_CONFIG_QUERY,
  ROUTING_CONFIG_QUERY,
  STATION_DISPLAY_BINDING_QUERY,
  TABLE_DISPLAY_QUERY,
} from './contract';
import { LocationsService } from './locations/locations.service';
import { OperatingHoursService } from './operating-hours/operating-hours.service';
import { OrganisationController } from './organisation.controller';
import { PrintRoutingService } from './print-routing/print-routing.service';
import { KdsBranchConfigQueryService } from './routing-config/kds-branch-config.query.service';
import { RoutingConfigQueryService } from './routing-config/routing-config.query.service';
import { StationRoutingService } from './station-routing/station-routing.service';
import { StationDisplayBindingQueryService } from './stations/station-display-binding.query.service';
import { StationsService } from './stations/stations.service';
import { TableDisplayQueryService } from './tables/table-display.query.service';
import { TablesService } from './tables/tables.service';
import { WarehousesService } from './warehouses/warehouses.service';

/**
 * Organisation bounded context (Phase 15, ADR 0008).
 *
 * Depends on IdentityModule purely to reuse the EXISTING guard chain
 * (JwtAuthGuard → TenantContextGuard → PermissionGuard) and on AuditModule for
 * the existing audit writer. Neither is modified: no new tenant-context
 * mechanism, no new audit implementation, no change to authentication or RBAC.
 */
@Module({
  // B1-2: the Identity <-> Organisation contract edge is now BIDIRECTIONAL —
  // Organisation consumes `identity/contract`'s SCOPE_REVIEW_QUERY for the M-4+
  // second-active-branch gate, and Identity consumes this module's
  // BRANCH_BRAND_QUERY for the brand->branch limb of the scope lattice. Both
  // sides use `forwardRef()`, exactly as sales <-> treasury already do. No
  // private path is imported in either direction.
  imports: [forwardRef(() => IdentityModule), AuditModule],
  controllers: [OrganisationController],
  providers: [
    LocationsService,
    BrandsService,
    BranchesService,
    WarehousesService,
    CentralKitchensService,
    StationsService,
    TablesService,
    OperatingHoursService,
    PrintRoutingService,
    StationRoutingService,
    RoutingConfigQueryService,
    { provide: ROUTING_CONFIG_QUERY, useExisting: RoutingConfigQueryService },
    TableDisplayQueryService,
    { provide: TABLE_DISPLAY_QUERY, useExisting: TableDisplayQueryService },
    BranchCurrencyQueryService,
    { provide: BRANCH_CURRENCY_QUERY, useExisting: BranchCurrencyQueryService },
    StationDisplayBindingQueryService,
    {
      provide: STATION_DISPLAY_BINDING_QUERY,
      useExisting: StationDisplayBindingQueryService,
    },
    KdsBranchConfigQueryService,
    {
      provide: KDS_BRANCH_CONFIG_QUERY,
      useExisting: KdsBranchConfigQueryService,
    },
    // Minimum Operational Reporting (RPT-R1/R2/R3) — the Internal-MVP
    // single-active-branch fail-closed assertion, consumed only by the
    // `reporting` module. NOT branch-aware RBAC; D-2 untouched.
    BranchReportingScopeQueryService,
    {
      provide: BRANCH_REPORTING_SCOPE_QUERY,
      useExisting: BranchReportingScopeQueryService,
    },
    // B1-2 scoped RBAC — the branch's parent brand, for the lattice's
    // "BRAND X covers a branch whose parent brand is X" limb. Not an
    // authorization decision; grants nothing.
    BranchBrandQueryService,
    { provide: BRANCH_BRAND_QUERY, useExisting: BranchBrandQueryService },
    // B1-3 resource-derived authorization targets. These answer "what does this
    // row belong to?"; they never decide authorization.
    StationTargetResolver,
    { provide: ORG_STATION_TARGET_RESOLVER, useExisting: StationTargetResolver },
    TableTargetResolver,
    { provide: ORG_TABLE_TARGET_RESOLVER, useExisting: TableTargetResolver },
    WarehouseTargetResolver,
    {
      provide: ORG_WAREHOUSE_TARGET_RESOLVER,
      useExisting: WarehouseTargetResolver,
    },
    LocationTargetResolver,
    {
      provide: ORG_LOCATION_TARGET_RESOLVER,
      useExisting: LocationTargetResolver,
    },
  ],
  exports: [
    LocationsService,
    BrandsService,
    BranchesService,
    WarehousesService,
    CentralKitchensService,
    StationsService,
    TablesService,
    OperatingHoursService,
    PrintRoutingService,
    StationRoutingService,
    ROUTING_CONFIG_QUERY,
    TABLE_DISPLAY_QUERY,
    BRANCH_CURRENCY_QUERY,
    STATION_DISPLAY_BINDING_QUERY,
    KDS_BRANCH_CONFIG_QUERY,
    BRANCH_REPORTING_SCOPE_QUERY,
    BRANCH_BRAND_QUERY,
    ORG_STATION_TARGET_RESOLVER,
    ORG_TABLE_TARGET_RESOLVER,
    ORG_WAREHOUSE_TARGET_RESOLVER,
    ORG_LOCATION_TARGET_RESOLVER,
  ],
})
export class OrganisationModule {}
