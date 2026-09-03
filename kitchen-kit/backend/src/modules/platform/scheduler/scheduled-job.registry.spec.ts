import { Injectable, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ScheduledJobDefaultSchedule,
  ScheduledJobHandler,
} from '../contract/scheduled-job';
import { ScheduledJobHandlerFor } from './scheduled-job-handler.decorator';
import { ScheduledJobRegistry } from './scheduled-job.registry';

const VALID_SCHEDULE: ScheduledJobDefaultSchedule = {
  timezone: 'UTC',
  localTimeOfDay: 180,
  catchUpLimit: 3,
};

/** A fully-typed no-op handler; these tests exercise DISCOVERY, not execution. */
abstract class FixtureHandler implements ScheduledJobHandler<void> {
  abstract readonly jobType: string;
  readonly defaultSchedule: ScheduledJobDefaultSchedule = VALID_SCHEDULE;
  readonly maxAttempts: number = 3;
  detect(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Pure Nest-DI proof of `ScheduledJobRegistry`: it discovers decorated
 * providers from anywhere in the container, refuses ambiguity, and refuses a
 * malformed schedule at BOOTSTRAP rather than at 03:00 on a Sunday. The whole
 * production path (registry + occurrence store + real PostgreSQL + a real
 * domain job) is proven separately in `test/scheduler-core.e2e-spec.ts`.
 */
describe('ScheduledJobRegistry', () => {
  @Injectable()
  @ScheduledJobHandlerFor('registry.test.zulu')
  class ZuluJob extends FixtureHandler {
    readonly jobType = 'registry.test.zulu';
  }

  @Injectable()
  @ScheduledJobHandlerFor('registry.test.alpha')
  class AlphaJob extends FixtureHandler {
    readonly jobType = 'registry.test.alpha';
  }

  /** Deliberately undecorated: it must NOT be discovered. */
  @Injectable()
  class UndecoratedJob extends FixtureHandler {
    readonly jobType = 'registry.test.undecorated';
  }

  async function build(providers: Provider[]): Promise<ScheduledJobRegistry> {
    const moduleRef = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [ScheduledJobRegistry, ...providers],
    }).compile();
    await moduleRef.init();
    return moduleRef.get(ScheduledJobRegistry);
  }

  it('discovers every decorated provider in the container', async () => {
    const registry = await build([ZuluJob, AlphaJob]);
    expect(registry.registeredTypes).toEqual([
      'registry.test.alpha',
      'registry.test.zulu',
    ]);
  });

  it('ignores an undecorated provider, even one implementing the interface', async () => {
    const registry = await build([ZuluJob, UndecoratedJob]);
    expect(registry.registeredTypes).toEqual(['registry.test.zulu']);
    expect(registry.get('registry.test.undecorated')).toBeUndefined();
  });

  it('exposes handlers in a stable order, so telemetry and reports are reproducible', async () => {
    const registry = await build([ZuluJob, AlphaJob]);
    expect(registry.all.map((h) => h.jobType)).toEqual([
      'registry.test.alpha',
      'registry.test.zulu',
    ]);
  });

  it('an empty container registers nothing, and says so rather than pretending', async () => {
    const registry = await build([]);
    expect(registry.registeredTypes).toEqual([]);
    expect(registry.all).toEqual([]);
  });

  it('REFUSES two handlers for one job type at bootstrap', async () => {
    @Injectable()
    @ScheduledJobHandlerFor('registry.test.duplicate')
    class FirstDuplicate extends FixtureHandler {
      readonly jobType = 'registry.test.duplicate';
    }
    @Injectable()
    @ScheduledJobHandlerFor('registry.test.duplicate')
    class SecondDuplicate extends FixtureHandler {
      readonly jobType = 'registry.test.duplicate';
    }
    await expect(build([FirstDuplicate, SecondDuplicate])).rejects.toThrow(
      /Duplicate scheduled job handler for 'registry\.test\.duplicate'/,
    );
  });

  describe('bootstrap validation — a malformed schedule can never reach production', () => {
    const cases: Array<
      [
        string,
        Partial<ScheduledJobDefaultSchedule> & { maxAttempts?: number },
        RegExp,
      ]
    > = [
      [
        'an empty timezone',
        { timezone: '' },
        /declares no default schedule timezone/,
      ],
      [
        'a local time of day above 1439',
        { localTimeOfDay: 1440 },
        /must be a minute of the day/,
      ],
      [
        'a negative local time of day',
        { localTimeOfDay: -1 },
        /must be a minute of the day/,
      ],
      [
        'a zero catch-up horizon',
        { catchUpLimit: 0 },
        /bounded catch-up horizon/,
      ],
      [
        'an unbounded catch-up horizon',
        { catchUpLimit: 31 },
        /bounded catch-up horizon/,
      ],
      ['zero attempts', { maxAttempts: 0 }, /must be at least 1/],
    ];

    it.each(cases)('rejects %s', async (_label, overrides, expected) => {
      const { maxAttempts, ...scheduleOverrides } = overrides;
      @Injectable()
      @ScheduledJobHandlerFor('registry.test.malformed')
      class MalformedJob extends FixtureHandler {
        readonly jobType = 'registry.test.malformed';
        readonly defaultSchedule = {
          ...VALID_SCHEDULE,
          ...scheduleOverrides,
        };
        readonly maxAttempts = maxAttempts ?? 3;
      }
      await expect(build([MalformedJob])).rejects.toThrow(expected);
    });
  });
});
