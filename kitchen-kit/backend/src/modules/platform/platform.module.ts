import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { PartitionAdminConnectionService } from './partitioning/partition-admin-connection.service';
import { PartitionDdlService } from './partitioning/partition-ddl.service';
import { PartitionLifecycleJob } from './partitioning/partition-lifecycle.job';
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
 * else. It ships exactly ONE job handler of its own — `PartitionLifecycleJob`
 * (FR-DR-002) — as a deliberate exception to "zero job handlers by design":
 * every OTHER handler is domain-owned because it runs domain business logic
 * (Inventory's reconciliation, a future Governance audit-chain verifier), but
 * partition maintenance operates on PHYSICAL table structure spanning
 * multiple domains' schemas and needs the one elevated DB connection nothing
 * else in this repository should touch (`PartitionAdminConnectionService`) —
 * containing it here, rather than in any domain module, is what keeps that
 * connection unreachable from everywhere else. A domain still becomes
 * schedulable the normal way: declaring a provider carrying
 * `@ScheduledJobHandlerFor` in ITS OWN module, discovered through
 * `DiscoveryService`. This module still imports zero domain modules, and
 * always will.
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
    PartitionAdminConnectionService,
    PartitionDdlService,
    PartitionLifecycleJob,
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
