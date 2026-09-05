import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredLoggerService } from '../../../common/observability/logging/structured-logger.service';
import { ScheduledJobRunnerService } from './scheduled-job-runner.service';

/**
 * The LIVENESS TRIGGER for the scheduler substrate — and nothing more.
 *
 * ── WHY A PROCESS-LOCAL TIMER IS NOT "THE SCHEDULER" ──────────────────────
 * A `setInterval` scheduler is wrong because it makes an in-memory timer the
 * authority on whether an occurrence happened: restart the process and the
 * schedule is gone; run two instances and every occurrence runs twice. Neither
 * failure is possible here, because this class decides NOTHING:
 *
 *   which occurrences exist   — `platform.job_occurrences` (durable rows,
 *                               derived from durable schedules + code defaults)
 *   whether one already ran   — its primary key and its `state`
 *   which instance runs it    — the claim UPDATE's `FOR UPDATE SKIP LOCKED`
 *                               and the lease
 *
 * A tick that fires twice claims nothing the first tick already claimed. A tick
 * that never fires (this process is dead) leaves the work for another instance,
 * or for this one after a restart, with its occurrence identity intact. Ten
 * instances ticking at once execute each occurrence exactly once between them.
 * The timer therefore controls LATENCY, not correctness, which is precisely the
 * property that makes it acceptable — and it is why this file is small.
 *
 * ── SELF-RESCHEDULING `setTimeout`, NOT `setInterval` ─────────────────────
 * `setInterval` would queue a second tick while the first is still running,
 * against the same tenant batch, for no benefit. The next tick is scheduled
 * only after the previous one settles.
 *
 * ── DISABLED BY DEFAULT ───────────────────────────────────────────────────
 * `SCHEDULER_ENABLED` defaults to false. The e2e suites drive `runTick()`
 * directly with an injected instant, so nothing in the test harness depends on
 * a timer firing — no sleeps, no timing luck. A deployment turns it on
 * explicitly, and turning it on for every instance is the intended
 * configuration.
 */
@Injectable()
export class SchedulerHeartbeatService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Resolves when a tick in flight at shutdown has finished. */
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly runner: ScheduledJobRunnerService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('SCHEDULER_ENABLED') !== 'true') {
      this.logger.logEvent(
        'info',
        'scheduler.heartbeat.disabled',
        'Scheduler heartbeat disabled (SCHEDULER_ENABLED is not "true"). Durable ' +
          'occurrences are still claimable by any instance that has it enabled.',
      );
      return;
    }
    this.logger.logEvent(
      'info',
      'scheduler.heartbeat.enabled',
      'Scheduler heartbeat enabled.',
      { count: this.tickMs },
    );
    this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    // Stop starting new ticks, then let an in-flight tick finish. A tick killed
    // mid-execution is safe anyway — its occurrence keeps a lease that expires
    // and is reclaimed — but draining avoids manufacturing that case on every
    // ordinary deploy.
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight.catch(() => undefined);
  }

  private get tickMs(): number {
    return this.config.get<number>('SCHEDULER_TICK_MS', 30_000);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tickOnce().finally(() => this.schedule(this.tickMs));
    }, delayMs);
    this.timer.unref?.();
  }

  private async tickOnce(): Promise<void> {
    try {
      const result = await this.runner.runTick({
        tenantBatch: this.config.get<number>('SCHEDULER_TENANT_BATCH', 100),
        claimBatch: this.config.get<number>('SCHEDULER_CLAIM_BATCH', 10),
      });
      if (result.claimed > 0 || result.materialized > 0 || result.reaped > 0) {
        this.logger.logEvent(
          'info',
          'scheduler.tick.completed',
          'Scheduler tick completed.',
          {
            count: result.claimed,
            // Bounded integers only; no tenant id, no occurrence key.
            reason:
              `materialized=${result.materialized} claimed=${result.claimed} ` +
              `succeeded=${result.succeeded} failed=${result.failed} ` +
              `retried=${result.retried} leaseLost=${result.leaseLost} ` +
              `reaped=${result.reaped}`,
          },
        );
      }
    } catch (error) {
      // A tick failing is survivable by construction — the next one re-derives
      // everything from durable state — so it is logged and never rethrown into
      // an unhandled rejection that would take the process down.
      this.logger.logEvent(
        'error',
        'scheduler.tick.failed',
        'Scheduler tick failed; durable state is unchanged and the next tick retries.',
        {
          exceptionClass: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
