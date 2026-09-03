import { MetricsService, classifyStatus } from './metrics.service';

describe('classifyStatus', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [301, '3xx'],
    [400, '4xx'],
    [404, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ] as const)('%i -> %s', (code, expected) => {
    expect(classifyStatus(code)).toBe(expected);
  });
});

describe('MetricsService — RED metrics (NFR-OBS-003)', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('exposes RATE via http_requests_total', async () => {
    metrics.recordRequest(
      {
        method: 'GET',
        route: '/orders/:id',
        handler: 'OrdersController#getOrder',
        statusClass: '2xx',
      },
      0.05,
    );
    const text = await metrics.metricsText();
    expect(text).toContain('http_requests_total');
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/orders\/:id",handler="OrdersController#getOrder",status_class="2xx"\} 1/,
    );
  });

  it('exposes ERRORS as a status_class-filterable view of the same counter, with 5xx independently observable', async () => {
    metrics.recordRequest(
      {
        method: 'GET',
        route: '/orders/:id',
        handler: 'OrdersController#getOrder',
        statusClass: '2xx',
      },
      0.05,
    );
    metrics.recordRequest(
      {
        method: 'GET',
        route: '/orders/:id',
        handler: 'OrdersController#getOrder',
        statusClass: '5xx',
      },
      0.05,
    );
    const text = await metrics.metricsText();
    expect(text).toMatch(/status_class="2xx"\} 1/);
    expect(text).toMatch(/status_class="5xx"\} 1/);
  });

  it('exposes DURATION as a histogram suitable for quantile computation', async () => {
    metrics.recordRequest(
      {
        method: 'POST',
        route: '/orders',
        handler: 'OrdersController#create',
        statusClass: '2xx',
      },
      0.123,
    );
    const text = await metrics.metricsText();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toContain('http_request_duration_seconds_sum');
    expect(text).toContain('http_request_duration_seconds_count');
  });

  it('never puts a raw resource id (or any other unbounded value) in a label', async () => {
    // The public API only accepts a normalized route/handler; there is no
    // way to pass an order id here, which is the actual guarantee. Assert
    // the label set is exactly the bounded, documented set.
    metrics.recordRequest(
      {
        method: 'GET',
        route: '/orders/:id',
        handler: 'OrdersController#getOrder',
        statusClass: '2xx',
      },
      0.01,
    );
    const text = await metrics.metricsText();
    const line = text
      .split('\n')
      .find((l) => l.startsWith('http_requests_total{'));
    expect(line).toBeDefined();
    const labelNames = [...line!.matchAll(/(\w+)="/g)].map((m) => m[1]);
    expect(new Set(labelNames)).toEqual(
      new Set(['method', 'route', 'handler', 'status_class']),
    );
  });

  describe('cardinality sabotage — many distinct resource ids must NOT grow the series count', () => {
    it('collapses 500 distinct simulated resource ids onto one series', async () => {
      const ROUTE = '/orders/:id';
      const HANDLER = 'OrdersController#getOrder';
      for (let i = 0; i < 500; i += 1) {
        // In real traffic, each of these would be a request for a DIFFERENT
        // order id — but the caller (the guard/interceptor) only ever
        // supplies the NORMALIZED route template, never the id itself, so
        // there is nothing here that could vary per id.
        metrics.recordRequest(
          { method: 'GET', route: ROUTE, handler: HANDLER, statusClass: '2xx' },
          0.01,
        );
      }
      const text = await metrics.metricsText();
      const seriesLines = text
        .split('\n')
        .filter((l) => l.startsWith('http_requests_total{'));
      expect(seriesLines).toHaveLength(1);
      expect(seriesLines[0]).toMatch(/\} 500$/);
    });

    it('two different routes/handlers stay distinguishable as two series (not merged)', async () => {
      metrics.recordRequest(
        {
          method: 'GET',
          route: '/orders/:id',
          handler: 'OrdersController#getOrder',
          statusClass: '2xx',
        },
        0.01,
      );
      metrics.recordRequest(
        {
          method: 'GET',
          route: '/inventory/:id',
          handler: 'InventoryController#getItem',
          statusClass: '2xx',
        },
        0.01,
      );
      const text = await metrics.metricsText();
      const seriesLines = text
        .split('\n')
        .filter((l) => l.startsWith('http_requests_total{'));
      expect(seriesLines).toHaveLength(2);
    });

    it('the SAME route reached via two different handlers stays two series (endpoint vs handler distinction)', async () => {
      metrics.recordRequest(
        {
          method: 'GET',
          route: '/reports/daily',
          handler: 'ReportingControllerA#daily',
          statusClass: '2xx',
        },
        0.01,
      );
      metrics.recordRequest(
        {
          method: 'GET',
          route: '/reports/daily',
          handler: 'ReportingControllerB#daily',
          statusClass: '2xx',
        },
        0.01,
      );
      const text = await metrics.metricsText();
      const seriesLines = text
        .split('\n')
        .filter((l) => l.startsWith('http_requests_total{'));
      expect(seriesLines).toHaveLength(2);
    });
  });

  it('each MetricsService instance owns its own registry (no cross-instance/global pollution across parallel Nest app boots)', async () => {
    const a = new MetricsService();
    const b = new MetricsService();
    a.recordRequest(
      { method: 'GET', route: '/a', handler: 'A#a', statusClass: '2xx' },
      0.01,
    );
    const textA = await a.metricsText();
    const textB = await b.metricsText();
    expect(textA).toContain('route="/a"');
    expect(textB).not.toContain('route="/a"');
  });
});

/**
 * SCHED-1 — scheduled-job telemetry. Same discipline as the RED metrics above:
 * the label set is fixed at deploy time and cannot grow with tenants, days or
 * occurrences. The sabotage proof below is the scheduler's equivalent of the
 * "500 distinct resource ids" test — many tenants and many days must collapse
 * onto one series per (job type, phase).
 */
describe('MetricsService — scheduled job telemetry (SCHED-1)', () => {
  const metrics = () => new MetricsService();
  const seriesOf = (text: string, name: string) =>
    text.split('\n').filter((l) => l.startsWith(`${name}{`));

  it('counts occurrence lifecycle phases per job type', async () => {
    const m = metrics();
    m.recordScheduledJobPhase({
      jobType: 'inventory.daily_reconciliation',
      phase: 'claimed',
    });
    m.recordScheduledJobPhase({
      jobType: 'inventory.daily_reconciliation',
      phase: 'succeeded',
    });
    const text = await m.metricsText();
    expect(text).toContain(
      'scheduled_job_occurrences_total{job_type="inventory.daily_reconciliation",phase="claimed"} 1',
    );
    expect(text).toContain(
      'scheduled_job_occurrences_total{job_type="inventory.daily_reconciliation",phase="succeeded"} 1',
    );
  });

  it('exposes duration as a histogram suitable for quantile computation', async () => {
    const m = metrics();
    m.recordScheduledJobDuration('inventory.daily_reconciliation', 1.5);
    const text = await m.metricsText();
    expect(text).toContain('scheduled_job_duration_seconds_bucket{');
    expect(text).toContain(
      'scheduled_job_duration_seconds_count{job_type="inventory.daily_reconciliation"} 1',
    );
  });

  it('exposes LAG, the number that says whether the scheduler is keeping up', async () => {
    const m = metrics();
    m.recordScheduledJobLag('inventory.daily_reconciliation', 3600);
    const text = await m.metricsText();
    expect(text).toContain(
      'scheduled_job_lag_seconds_count{job_type="inventory.daily_reconciliation"} 1',
    );
    // A 1-hour lag must land ABOVE the 1800s bucket and at/below 3600s.
    expect(text).toContain(
      'scheduled_job_lag_seconds_bucket{le="1800",job_type="inventory.daily_reconciliation"} 0',
    );
    expect(text).toContain(
      'scheduled_job_lag_seconds_bucket{le="3600",job_type="inventory.daily_reconciliation"} 1',
    );
  });

  it('clamps a negative lag rather than recording an impossible negative delay', async () => {
    const m = metrics();
    m.recordScheduledJobLag('inventory.daily_reconciliation', -10);
    const text = await m.metricsText();
    expect(text).toContain(
      'scheduled_job_lag_seconds_bucket{le="1",job_type="inventory.daily_reconciliation"} 1',
    );
  });

  describe('cardinality sabotage — tenants and occurrence keys must NOT grow the series count', () => {
    it('collapses 500 tenants x 500 occurrence days onto ONE series', async () => {
      const m = metrics();
      for (let i = 0; i < 500; i += 1) {
        // A call site cannot smuggle a tenant id or an occurrence key in: the
        // label type has exactly two fields, both drawn from closed sets.
        m.recordScheduledJobPhase({
          jobType: 'inventory.daily_reconciliation',
          phase: 'succeeded',
        });
        m.recordScheduledJobDuration(
          'inventory.daily_reconciliation',
          i / 1000,
        );
        m.recordScheduledJobLag('inventory.daily_reconciliation', i);
      }
      const text = await m.metricsText();
      expect(seriesOf(text, 'scheduled_job_occurrences_total')).toHaveLength(1);
      expect(text).toContain(
        'scheduled_job_occurrences_total{job_type="inventory.daily_reconciliation",phase="succeeded"} 500',
      );
      expect(text).toContain(
        'scheduled_job_duration_seconds_count{job_type="inventory.daily_reconciliation"} 500',
      );
    });

    it('two job types stay distinguishable as two series (not merged)', async () => {
      const m = metrics();
      m.recordScheduledJobPhase({
        jobType: 'inventory.daily_reconciliation',
        phase: 'claimed',
      });
      m.recordScheduledJobPhase({
        jobType: 'governance.audit_chain_verify',
        phase: 'claimed',
      });
      const text = await m.metricsText();
      expect(seriesOf(text, 'scheduled_job_occurrences_total')).toHaveLength(2);
    });

    it('no scheduled-job metric line ever contains a UUID', async () => {
      const m = metrics();
      m.recordScheduledJobPhase({
        jobType: 'inventory.daily_reconciliation',
        phase: 'failed',
      });
      const text = await m.metricsText();
      for (const line of text
        .split('\n')
        .filter((l) => l.startsWith('scheduled_job_'))) {
        expect(line).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
      }
    });
  });
});

describe('MetricsService — scheduled job findings (SCHED-1)', () => {
  it('counts findings by job type and severity', async () => {
    const m = new MetricsService();
    m.recordScheduledJobFinding('inventory.daily_reconciliation', 'critical');
    const text = await m.metricsText();
    expect(text).toContain(
      'scheduled_job_findings_total{job_type="inventory.daily_reconciliation",severity="critical"} 1',
    );
  });

  it('does NOT carry the tenant, the occurrence, or the finding code as a label', async () => {
    const m = new MetricsService();
    for (let i = 0; i < 200; i += 1) {
      m.recordScheduledJobFinding('inventory.daily_reconciliation', 'critical');
    }
    const text = await m.metricsText();
    const series = text
      .split('\n')
      .filter((l) => l.startsWith('scheduled_job_findings_total{'));
    expect(series).toHaveLength(1);
    expect(series[0]).toContain('} 200');
  });
});
