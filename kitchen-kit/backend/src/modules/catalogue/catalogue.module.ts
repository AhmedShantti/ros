import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { AvailabilityService } from './availability/availability.service';
import { CatalogueCompletenessService } from './catalogue-completeness.service';
import { CatalogueController } from './catalogue.controller';
import { CategoriesService } from './categories/categories.service';
import { CATALOGUE_FIRE_FACTS_QUERY } from './contract';
import { CatalogueFireFactsQueryService } from './fire-facts/catalogue-fire-facts.query.service';
import { MenuItemsService } from './menu-items/menu-items.service';
import { MenusService } from './menus/menus.service';
import { ModifierGroupsService } from './modifier-groups/modifier-groups.service';
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
 */
@Module({
  imports: [IdentityModule, AuditModule],
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
