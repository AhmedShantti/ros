import {
  SCHEDULED_JOB_OUTCOME,
  SCHEDULED_JOB_PHASE,
  SCHEDULER_LEASE_MS,
  SCHEDULER_LEASE_RENEW_MS,
  SCHEDULER_RETRY_BASE_MS,
  SCHEDULER_RETRY_CAP_MS,
  retryDelayMs,
} from './scheduled-job.constants';

describe('scheduler retry backoff', () => {
  it('is exponential from the base', () => {
    expect(retryDelayMs(1)).toBe(SCHEDULER_RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(SCHEDULER_RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(SCHEDULER_RETRY_BASE_MS * 4);
  });

  it('is CAPPED, so a retry can never be scheduled beyond the cap', () => {
    expect(retryDelayMs(50)).toBe(SCHEDULER_RETRY_CAP_MS);
    expect(retryDelayMs(1000)).toBe(SCHEDULER_RETRY_CAP_MS);
  });

  it('is deterministic — no jitter, which is what lets a test assert a value', () => {
    expect(retryDelayMs(2)).toBe(retryDelayMs(2));
  });

  it('is non-decreasing', () => {
    for (let attempt = 1; attempt < 20; attempt += 1) {
      expect(retryDelayMs(attempt + 1)).toBeGreaterThanOrEqual(
        retryDelayMs(attempt),
      );
    }
  });

  it('treats a zero/negative attempt as the first attempt rather than throwing', () => {
    expect(retryDelayMs(0)).toBe(SCHEDULER_RETRY_BASE_MS);
    expect(retryDelayMs(-5)).toBe(SCHEDULER_RETRY_BASE_MS);
  });
});

describe('scheduler lease constants', () => {
  it('renews at half the lease, leaving a full half-lease of slack for a slow renewal', () => {
    expect(SCHEDULER_LEASE_RENEW_MS).toBe(SCHEDULER_LEASE_MS / 2);
    expect(SCHEDULER_LEASE_RENEW_MS).toBeLessThan(SCHEDULER_LEASE_MS);
  });
});

describe('bounded telemetry vocabularies', () => {
  it('outcome codes are short, snake_case tokens — never free text or a message', () => {
    for (const code of Object.values(SCHEDULED_JOB_OUTCOME)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    }
  });

  it('phases are short, snake_case tokens safe as a metric label value', () => {
    for (const phase of Object.values(SCHEDULED_JOB_PHASE)) {
      expect(phase).toMatch(/^[a-z][a-z0-9_]{0,30}$/);
    }
  });

  it('the phase set is CLOSED and small, bounding the metric series count', () => {
    expect(Object.values(SCHEDULED_JOB_PHASE)).toHaveLength(8);
  });
});
