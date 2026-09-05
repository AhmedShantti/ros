import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ScheduledJobHandler } from '../contract/scheduled-job';
import { ScheduledJobHandlerFor } from './scheduled-job-handler.decorator';

/**
 * The scheduled-job handler registry.
 *
 * Scans the container ONCE at bootstrap (never per tick) and freezes the
 * result, mirroring `DomainEventHandlerRegistry`/`SyncOperationRegistry`
 * lifetime rules: every provider across the application is constructed before
 * any `onModuleInit` fires, so a constructor-time scan could miss a module
 * later in the graph.
 *
 * The registry is also what makes `job_type` a SAFE metric label: the set of
 * job types is fixed at deploy time by how many handlers the application
 * registers, not by how many tenants or occurrences exist.
 */
@Injectable()
export class ScheduledJobRegistry implements OnModuleInit {
  private readonly logger = new Logger(ScheduledJobRegistry.name);
  private handlers: ReadonlyMap<string, ScheduledJobHandler> = new Map();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found = new Map<string, ScheduledJobHandler>();
    for (const wrapper of this.discovery.getProviders({
      metadataKey: ScheduledJobHandlerFor.KEY,
    })) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') continue;
      const handler = instance as ScheduledJobHandler;
      if (typeof handler.detect !== 'function') continue;

      const type =
        this.discovery.getMetadataByDecorator(
          ScheduledJobHandlerFor,
          wrapper,
        ) ?? handler.jobType;
      if (typeof type !== 'string' || type.length === 0) continue;

      const existing = found.get(type);
      if (existing) {
        // Two handlers for one job type is ambiguous, and silently picking one
        // would make which code runs depend on container ordering. Fail at
        // bootstrap, not at 03:00 on a Sunday.
        throw new Error(
          `Duplicate scheduled job handler for '${type}': ` +
            `${existing.constructor.name} and ${handler.constructor.name}.`,
        );
      }
      assertRegistrable(type, handler);
      found.set(type, handler);
    }
    this.handlers = found;
    this.logger.log(
      found.size === 0
        ? 'Scheduler substrate ready with 0 job handlers: no occurrence will ' +
            'ever be materialised until a domain registers one.'
        : `Scheduler substrate ready with ${found.size} job handler(s): ` +
            `${[...found.keys()].sort().join(', ')}`,
    );
  }

  get(type: string): ScheduledJobHandler | undefined {
    return this.handlers.get(type);
  }

  /** Every registered handler, in a stable order. */
  get all(): readonly ScheduledJobHandler[] {
    return [...this.handlers.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, handler]) => handler);
  }

  get registeredTypes(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }
}

/**
 * Bootstrap-time validation. A handler whose default schedule is malformed
 * would either never fire or fire at the wrong hour forever; both are silent
 * failures, and a scheduler's whole value is that it is not silent.
 */
function assertRegistrable(type: string, handler: ScheduledJobHandler): void {
  const s = handler.defaultSchedule;
  if (!s || typeof s.timezone !== 'string' || s.timezone.length === 0) {
    throw new Error(
      `Scheduled job handler '${type}' declares no default schedule timezone. ` +
        'An IANA zone is required — there is deliberately no "server local" option.',
    );
  }
  if (
    !Number.isInteger(s.localTimeOfDay) ||
    s.localTimeOfDay < 0 ||
    s.localTimeOfDay > 1439
  ) {
    throw new Error(
      `Scheduled job handler '${type}' declares localTimeOfDay=${String(
        s.localTimeOfDay,
      )}; must be a minute of the day (0..1439).`,
    );
  }
  if (
    !Number.isInteger(s.catchUpLimit) ||
    s.catchUpLimit < 1 ||
    s.catchUpLimit > 30
  ) {
    throw new Error(
      `Scheduled job handler '${type}' declares catchUpLimit=${String(
        s.catchUpLimit,
      )}; must be 1..30 (the bounded catch-up horizon).`,
    );
  }
  if (!Number.isInteger(handler.maxAttempts) || handler.maxAttempts < 1) {
    throw new Error(
      `Scheduled job handler '${type}' declares maxAttempts=${String(
        handler.maxAttempts,
      )}; must be at least 1.`,
    );
  }
}
