import { Module } from '@nestjs/common';
import { AuditModule } from '../governance/audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { ProductionController } from './production.controller';
import { RecipesService } from './recipes/recipes.service';
import { SubstituteGroupsService } from './substitute-groups/substitute-groups.service';
import { RecipeVersionsService } from './versions/recipe-versions.service';

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
  providers: [RecipesService, RecipeVersionsService, SubstituteGroupsService],
  exports: [RecipesService, RecipeVersionsService, SubstituteGroupsService],
})
export class ProductionModule {}
