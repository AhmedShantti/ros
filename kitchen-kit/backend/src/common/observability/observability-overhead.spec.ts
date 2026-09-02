import { sanitizeMetadata } from './logging/redaction';
import { MetricsService } from './metrics/metrics.service';
import { ObservabilityContextService } from './context/observability-context';

/**
 * SRS §27.6 — observability itself must not materially degrade the API
 * (task §20). This is a MICROBENCHMARK of the instrumentation PRIMITIVES in
 * isolation (sanitisation, metric recording, ALS context creation) — it does
 * not, and cannot, prove an SRS performance NFR (NFR-PERF-030/031) on its
 * own; those are proven or disproven by the request-level p95 the RED
 * histogram actually measures in a real deployment. What this suite proves:
 *
 *   - sanitisation cost is bounded (does not grow unboundedly with a
 *     moderately-sized metadata object);
 *   - registering N requests' worth of metrics does NOT create a new
 *     Prometheus time series per request (bounded label cardinality, see
 *     `metrics.service.spec.ts` for the correctness proof; this asserts the
 *     PERFORMANCE consequence — recording stays cheap at volume);
 *   - creating/tearing down an AsyncLocalStorage run() context many times is
 *     cheap (no accumulating cost per request).
 */
describe('Observability primitives — bounded overhead (informational, not an SRS NFR proof)', () => {
  it('sanitizeMetadata stays well under 1ms per call for a representative request-completion payload', () => {
    const payload = {
      event: 'http.request.completed',
      route: '/orders/:id',
      handler: 'OrdersController#getOrder',
      method: 'GET',
      statusCode: 200,
      statusClass: '2xx',
      durationMs: 12.34,
      correlationId: 'corr-1',
      causationId: null,
    };
    const iterations = 5000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      sanitizeMetadata(payload);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const perCallMs = elapsedMs / iterations;
    expect(perCallMs).toBeLessThan(1);
  });

  it('recording 10,000 requests across a fixed, bounded label set does not create new series and stays cheap per call', async () => {
    const metrics = new MetricsService();
    const iterations = 10_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      metrics.recordRequest(
        {
          method: 'GET',
          route: '/orders/:id',
          handler: 'OrdersController#getOrder',
          statusClass: '2xx',
        },
        0.01,
      );
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const perCallMs = elapsedMs / iterations;
    expect(perCallMs).toBeLessThan(0.5);

    const text = await metrics.metricsText();
    const seriesLines = text
      .split('\n')
      .filter((l) => l.startsWith('http_requests_total{'));
    expect(seriesLines).toHaveLength(1); // NOT 10,000 series
  });

  it('creating and tearing down an ALS run() context many times is cheap (no per-request accumulation)', () => {
    const ctx = new ObservabilityContextService();
    const iterations = 10_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      ctx.run(
        {
          correlationId: `c-${i}`,
          causationId: null,
          tenantId: null,
          branchId: null,
          route: null,
          handler: null,
          method: 'GET',
          startedAtNs: process.hrtime.bigint(),
          completed: false,
        },
        () => {
          ctx.enrichRoute('/x', 'X#y');
        },
      );
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const perCallMs = elapsedMs / iterations;
    expect(perCallMs).toBeLessThan(0.2);
  });
});
