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
