import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { PRODUCTION_CONSUMPTION_QUERY } from './contract/consumption.contract';
import { ConsumptionResolutionService } from './costing/consumption-resolution.service';
import { ModifierRecipeEffectsService } from './costing/modifier-recipe-effects.service';
import { RecipeCompletenessService } from './costing/recipe-completeness.service';
import { RECIPE_COST_RECOMPUTER } from './costing/recipe-cost.port';
import { RecipeCostService } from './costing/recipe-cost.service';
import { StockValuationService } from './costing/stock-valuation.service';
import { ProductionController } from './production.controller';
import { RecipesService } from './recipes/recipes.service';
import { SubstituteGroupsService } from './substitute-groups/substitute-groups.service';
import { RecipeVersionsService } from './versions/recipe-versions.service';
import { RecipeTargetResolver } from './recipes/scope-target.resolver';
import { PRODUCTION_RECIPE_TARGET_RESOLVER } from './contract';

/**
 * Production Spec bounded context (D-17-02 … D-17-08, GAP-1, GAP-2).
 *
 * Reuses the existing guard chain and the existing tamper-evident audit writer.
 * Introduces NO new infrastructure: no scheduler, no jobs, no outbox, no event
 * bus, no notification system, no approval workflow, no database trigger.
 *
 * The SRS §6 event catalogue names `recipe.version.published`. No event is
 * emitted: the repository contains no event infrastructure and the design gate
 * forbids inventing any. Publication is recorded in `governance.audit_entries`
 * via the existing AuditService — a tamper-evident record, not an event, with
 * no subscriber. The event remains DEFERRED.
 */
@Module({
  imports: [IdentityModule, AuditModule],
  controllers: [ProductionController],
  providers: [
    RecipeTargetResolver,
    {
      provide: PRODUCTION_RECIPE_TARGET_RESOLVER,
      useExisting: RecipeTargetResolver,
    },
    RecipesService,
    RecipeVersionsService,
    SubstituteGroupsService,
    // D-17-05 NARROW AMENDMENT (design gate 4.1): the costing substrate.
    StockValuationService,
    RecipeCostService,
    // BR-MNU-012's third clause: the "recipes requiring completion" report.
    RecipeCompletenessService,
    { provide: RECIPE_COST_RECOMPUTER, useExisting: RecipeCostService },
    // P1F-2 — D-17-07 resolution (modifier -> recipe effects) and the
    // resolveConsumptionBasis/planConsumption public contract.
    ModifierRecipeEffectsService,
    ConsumptionResolutionService,
    {
      provide: PRODUCTION_CONSUMPTION_QUERY,
      useExisting: ConsumptionResolutionService,
    },
  ],
  exports: [
    PRODUCTION_RECIPE_TARGET_RESOLVER,
    RecipesService,
    RecipeVersionsService,
    SubstituteGroupsService,
    StockValuationService,
    RecipeCostService,
    RecipeCompletenessService,
    RECIPE_COST_RECOMPUTER,
    PRODUCTION_CONSUMPTION_QUERY,
  ],
})
export class ProductionModule {}
