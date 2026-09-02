import { ExecutionContext } from '@nestjs/common';
import { ObservabilityContextService } from '../context/observability-context';
import { ObservabilityRouteGuard } from './route-context.guard';

class FakeController {}
function fakeHandler(): void {
  /* no-op */
}

function fakeContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getClass: () => FakeController,
    getHandler: () => fakeHandler,
  } as unknown as ExecutionContext;
}

describe('ObservabilityRouteGuard', () => {
  it('always allows the request through', () => {
    const context = new ObservabilityContextService();
    const guard = new ObservabilityRouteGuard(context);
    context.run(
      {
        correlationId: 'c',
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
        expect(
          guard.canActivate(
            fakeContext({ route: { path: '/x/:id' }, baseUrl: '' }),
          ),
        ).toBe(true);
      },
    );
  });

  it('normalizes the route from request.route.path + baseUrl and sets a stable Controller#handler identity', () => {
    const context = new ObservabilityContextService();
    const guard = new ObservabilityRouteGuard(context);
    context.run(
      {
        correlationId: 'c',
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
        guard.canActivate(
          fakeContext({ route: { path: '/:id' }, baseUrl: '/orders' }),
        );
        const store = context.get();
        expect(store?.route).toBe('/orders/:id');
        expect(store?.handler).toBe('FakeController#fakeHandler');
      },
    );
  });

  it('labels a request with no matched route as "unmatched" rather than a raw path', () => {
    const context = new ObservabilityContextService();
    const guard = new ObservabilityRouteGuard(context);
    context.run(
      {
        correlationId: 'c',
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
        guard.canActivate(fakeContext({ route: undefined, baseUrl: '' }));
        expect(context.get()?.route).toBe('unmatched');
      },
    );
  });

  it('is a no-op for a non-HTTP execution context', () => {
    const context = new ObservabilityContextService();
    const guard = new ObservabilityRouteGuard(context);
    const rpcContext = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;
    expect(guard.canActivate(rpcContext)).toBe(true);
  });
});
