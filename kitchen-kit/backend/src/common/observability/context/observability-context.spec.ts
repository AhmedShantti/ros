import {
  ObservabilityContextService,
  ObservabilityStore,
} from './observability-context';

function makeStore(correlationId: string): ObservabilityStore {
  return {
    correlationId,
    causationId: null,
    tenantId: null,
    branchId: null,
    route: null,
    handler: null,
    method: 'GET',
    startedAtNs: process.hrtime.bigint(),
    completed: false,
  };
}

describe('ObservabilityContextService (AsyncLocalStorage)', () => {
  it('returns undefined outside any run()', () => {
    const ctx = new ObservabilityContextService();
    expect(ctx.get()).toBeUndefined();
  });

  it('exposes the running store inside run()', () => {
    const ctx = new ObservabilityContextService();
    ctx.run(makeStore('req-1'), () => {
      expect(ctx.get()?.correlationId).toBe('req-1');
    });
  });

  it('enrichRoute/enrichTenant mutate only the active store', () => {
    const ctx = new ObservabilityContextService();
    ctx.run(makeStore('req-1'), () => {
      ctx.enrichRoute('/orders/:id', 'OrdersController#getOrder');
      ctx.enrichTenant('tenant-1', 'branch-1');
      const store = ctx.get();
      expect(store?.route).toBe('/orders/:id');
      expect(store?.handler).toBe('OrdersController#getOrder');
      expect(store?.tenantId).toBe('tenant-1');
      expect(store?.branchId).toBe('branch-1');
    });
  });

  it('enrichment is a no-op outside any run() (never throws)', () => {
    const ctx = new ObservabilityContextService();
    expect(() => ctx.enrichRoute('/x', 'X#y')).not.toThrow();
    expect(() => ctx.enrichTenant('t', 'b')).not.toThrow();
  });

  it("concurrent async executions never see each other's context (no cross-request leakage)", async () => {
    const ctx = new ObservabilityContextService();

    const observedFor = async (
      id: string,
      delayMs: number,
    ): Promise<{ id: string; tenantId: string | null }> => {
      return ctx.run(makeStore(id), async () => {
        ctx.enrichTenant(`tenant-${id}`, null);
        // Yield the event loop so a genuinely SHARED (non-ALS) global would
        // get clobbered by the other concurrent execution here.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const store = ctx.get();
        return { id: store!.correlationId, tenantId: store!.tenantId };
      });
    };

    const [a, b, c] = await Promise.all([
      observedFor('req-A', 15),
      observedFor('req-B', 5),
      observedFor('req-C', 10),
    ]);

    expect(a).toEqual({ id: 'req-A', tenantId: 'tenant-req-A' });
    expect(b).toEqual({ id: 'req-B', tenantId: 'tenant-req-B' });
    expect(c).toEqual({ id: 'req-C', tenantId: 'tenant-req-C' });
  });

  it('runs many concurrent contexts and every one reports its own identity only', async () => {
    const ctx = new ObservabilityContextService();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx.run(makeStore(`req-${i}`), async () => {
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          return ctx.get()?.correlationId;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: N }, (_, i) => `req-${i}`));
  });
});
