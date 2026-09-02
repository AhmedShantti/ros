import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { SyncOperationHandler } from '../contract/sync-operation-handler';
import { SyncOperationHandlerFor } from './sync-operation-handler.decorator';

/**
 * The operation-handler registry.
 *
 * Scans the container ONCE at bootstrap (never per request) and freezes the
 * result, mirroring `DomainEventHandlerRegistry`'s lifetime rules: all providers
 * across the application are constructed before any `onModuleInit` fires, so a
 * constructor-time scan could miss a module later in the graph.
 *
 * ── D4-1A SHIPS ZERO PRODUCTION HANDLERS, DELIBERATELY ────────────────────
 * This slice is the protocol kernel, and the ratification's boundary is
 * explicit: "conflict handling for domains that actually exist", "Do NOT
 * implement all domain handlers". A kernel with an invented `order.create`
 * handler would be a domain slice wearing a protocol slice's name, and it would
 * pre-empt D4-1B's revalidation and conflict design.
 *
 * The honest consequence, stated rather than hidden: on a production deployment
 * of D4-1A every operation type is answered `rejected/unknown_operation_type`.
 * The protocol, its idempotency, its crash recovery and its ordering are all
 * real and exercised; the domains attach in D4-1B.
 */
@Injectable()
export class SyncOperationRegistry implements OnModuleInit {
  private readonly logger = new Logger(SyncOperationRegistry.name);
  private handlers: ReadonlyMap<string, SyncOperationHandler> = new Map();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found = new Map<string, SyncOperationHandler>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: SyncOperationHandlerFor.KEY,
    })) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') continue;
      const handler = instance as SyncOperationHandler;
      if (typeof handler.apply !== 'function') continue;

      const type =
        this.discovery.getMetadataByDecorator(
          SyncOperationHandlerFor,
          wrapper,
        ) ?? handler.operationType;
      if (typeof type !== 'string' || type.length === 0) continue;

      const existing = found.get(type);
      if (existing) {
        // Two handlers for one operation type is ambiguous, and silently
        // picking one would make the applied semantics depend on container
        // ordering. Fail at bootstrap, not at the first offline sale.
        throw new Error(
          `Duplicate sync operation handler for '${type}': ` +
            `${existing.constructor.name} and ${handler.constructor.name}.`,
        );
      }
      found.set(type, handler);
    }
    this.handlers = found;
    this.logger.log(
      found.size === 0
        ? 'Sync protocol kernel ready with 0 operation handlers (D4-1A): every ' +
            'operation type is rejected as unknown until D4-1B attaches domains.'
        : `Sync protocol kernel ready with ${found.size} operation handler(s): ` +
            `${[...found.keys()].sort().join(', ')}`,
    );
  }

  get(type: string): SyncOperationHandler | undefined {
    return this.handlers.get(type);
  }

  get registeredTypes(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }
}
