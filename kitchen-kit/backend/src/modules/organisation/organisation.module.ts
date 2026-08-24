import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { BranchesService } from './branches/branches.service';
import { BrandsService } from './brands/brands.service';
import { CentralKitchensService } from './central-kitchens/central-kitchens.service';
import { ROUTING_CONFIG_QUERY, TABLE_DISPLAY_QUERY } from './contract';
import { LocationsService } from './locations/locations.service';
import { OperatingHoursService } from './operating-hours/operating-hours.service';
import { OrganisationController } from './organisation.controller';
import { PrintRoutingService } from './print-routing/print-routing.service';
import { RoutingConfigQueryService } from './routing-config/routing-config.query.service';
import { StationRoutingService } from './station-routing/station-routing.service';
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
  ],
})
export class OrganisationModule {}
