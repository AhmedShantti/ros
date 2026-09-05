import { DiscoveryService } from '@nestjs/core';

/**
 * Marks a provider as the sync operation handler for one operation type.
 *
 * `@SyncOperationHandlerFor('order.create') @Injectable() class Foo implements SyncOperationHandler {}`
 * — declared as an ordinary provider in ITS OWN bounded-context module.
 * `SyncOperationRegistry` discovers it at bootstrap through `DiscoveryService`,
 * which scans the whole Nest container, exactly as `DomainEventHandler` already
 * does for transactional event handlers.
 *
 * That is what keeps the kernel domain-free: `modules/sync` never imports Sales,
 * Treasury or Kitchen; it scans for a metadata key. A domain adds offline
 * support by adding a provider, not by editing the protocol.
 */
export const SyncOperationHandlerFor =
  DiscoveryService.createDecorator<string>();
