import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { BranchCurrencyQueryService } from './branches/branch-currency.query.service';
import { BranchesService } from './branches/branches.service';
import { BrandsService } from './brands/brands.service';
import { CentralKitchensService } from './central-kitchens/central-kitchens.service';
import {
  BRANCH_CURRENCY_QUERY,
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
  imports: [IdentityModule, AuditModule],
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
  ],
})
export class OrganisationModule {}
