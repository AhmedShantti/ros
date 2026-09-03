import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { ScheduledJobFindingWriter } from './scheduler/scheduled-job-finding.writer';
import { ScheduledJobOccurrenceStore } from './scheduler/scheduled-job-occurrence.store';
import { ScheduledJobRegistry } from './scheduler/scheduled-job.registry';
import { ScheduledJobRunnerService } from './scheduler/scheduled-job-runner.service';
import { SchedulerHeartbeatService } from './scheduler/scheduler-heartbeat.service';

/**
 * Platform bounded context — SCHED-1 durable scheduled job execution.
 *
 * SRS §25.1 names a `platform` schema ("outbox, jobs, notifications,
 * feature_flags, migrations"); this module owns the `jobs` half and nothing
 * else. It ships ZERO job handlers by design: a domain becomes schedulable by
 * declaring a provider carrying `@ScheduledJobHandlerFor` in ITS OWN module,
 * which `ScheduledJobRegistry` discovers through `DiscoveryService`. That is
 * what keeps this module free of every domain — it imports Inventory,
 * Reporting and Governance exactly zero times, and always will.
 *
 * Nothing here is exported except through `platform/contract`.
 */
@Module({
  imports: [
    DiscoveryModule,
    // G1-3 conventions: the runner emits its telemetry through the SAME
    // `MetricsService`/`StructuredLoggerService`/`ObservabilityContextService`
    // the HTTP path uses, rather than opening a second observability channel
    // with its own format and its own label discipline.
    ObservabilityModule,
  ],
  providers: [
    ScheduledJobRegistry,
    ScheduledJobOccurrenceStore,
    ScheduledJobFindingWriter,
    ScheduledJobRunnerService,
    SchedulerHeartbeatService,
  ],
  exports: [
    // Consumed only via `platform/contract`'s re-export; a domain handler
    // records its findings through this writer, inside the substrate's own
    // transaction.
    ScheduledJobFindingWriter,
    // Exported so an operator/diagnostic caller (and the e2e suites) can drive
    // a deterministic tick without a timer.
    ScheduledJobRunnerService,
    ScheduledJobRegistry,
  ],
})
export class PlatformModule {}
