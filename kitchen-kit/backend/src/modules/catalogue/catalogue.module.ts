import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { LocalisationModule } from '../localisation/localisation.module';
import { AvailabilityService } from './availability/availability.service';
import { CatalogueCompletenessService } from './catalogue-completeness.service';
import { CatalogueController } from './catalogue.controller';
import { CategoriesService } from './categories/categories.service';
import { CATALOGUE_FIRE_FACTS_QUERY } from './contract';
import { CatalogueFireFactsQueryService } from './fire-facts/catalogue-fire-facts.query.service';
import { MenuItemsService } from './menu-items/menu-items.service';
import { MenusService } from './menus/menus.service';
import { ModifierGroupsService } from './modifier-groups/modifier-groups.service';
import { PosMenuService } from './pos-menu/pos-menu.service';
import { PriceListsService } from './price-lists/price-lists.service';
import { PriceResolutionService } from './pricing/price-resolution.service';
import {
  AvailabilityRuleTargetResolver,
  PriceListTargetResolver,
} from './price-lists/scope-target.resolvers';
import {
  CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER,
  CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
} from './contract';

/**
 * Catalogue bounded context (Phase 16, ADR-ratified design gate C-01…C-11).
 *
 * Reuses the existing guard chain (IdentityModule) and the existing
 * tamper-evident audit writer (AuditModule). Neither is modified: no new
 * tenant-context mechanism, no parallel audit system, no change to Auth, RBAC or
 * Organisation.
 *
 * DEMO-TAX-CLASS-BACKEND-P0 adds the FIRST `catalogue -> localisation` edge,
 * through `localisation/contract` only (`SELLABLE_TAX_CLASSES_QUERY`) —
 * `MenuItemsService` never imports a Localisation internal path.
 */
@Module({
  imports: [IdentityModule, AuditModule, LocalisationModule],
  controllers: [CatalogueController],
  providers: [
    PriceListTargetResolver,
    {
      provide: CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
      useExisting: PriceListTargetResolver,
    },
    AvailabilityRuleTargetResolver,
    {
      provide: CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER,
      useExisting: AvailabilityRuleTargetResolver,
    },
    MenusService,
    CategoriesService,
    MenuItemsService,
    ModifierGroupsService,
    PriceListsService,
    PriceResolutionService,
    AvailabilityService,
    CatalogueCompletenessService,
    CatalogueFireFactsQueryService,
    PosMenuService,
    {
      provide: CATALOGUE_FIRE_FACTS_QUERY,
      useExisting: CatalogueFireFactsQueryService,
    },
  ],
  exports: [
    CATALOGUE_PRICE_LIST_TARGET_RESOLVER,
    CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER,
    MenusService,
    CategoriesService,
    MenuItemsService,
    ModifierGroupsService,
    PriceListsService,
    PriceResolutionService,
    AvailabilityService,
    CatalogueCompletenessService,
    CATALOGUE_FIRE_FACTS_QUERY,
  ],
})
export class CatalogueModule {}
