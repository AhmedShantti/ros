import { DiscoveryService } from '@nestjs/core';

/**
 * Marks a provider as the scheduled-job handler for one job type.
 *
 * `@ScheduledJobHandlerFor('inventory.daily_reconciliation') @Injectable()`
 * — declared as an ordinary provider in ITS OWN bounded-context module.
 * `ScheduledJobRegistry` discovers it at bootstrap through `DiscoveryService`,
 * which scans the whole Nest container, exactly as `DomainEventHandler` and
 * `SyncOperationHandlerFor` already do.
 *
 * That is what keeps the substrate domain-free: `modules/platform` never
 * imports Inventory, Reporting or Governance; it scans for a metadata key. A
 * domain becomes schedulable by adding a provider, not by editing the
 * scheduler.
 */
export const ScheduledJobHandlerFor =
  DiscoveryService.createDecorator<string>();
