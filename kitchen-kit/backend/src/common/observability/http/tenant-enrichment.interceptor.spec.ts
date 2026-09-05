import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { ObservabilityContextService } from '../context/observability-context';
import { TenantEnrichmentInterceptor } from './tenant-enrichment.interceptor';

function fakeContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const nextHandler: CallHandler = { handle: () => of('ok') };

function freshStore() {
  return {
    correlationId: 'c',
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

describe('TenantEnrichmentInterceptor', () => {
  it('enriches tenant/branch ONLY from request.authorization.context (trusted, live-verified)', (done) => {
    const context = new ObservabilityContextService();
    const interceptor = new TenantEnrichmentInterceptor(context);
    context.run(freshStore(), () => {
      const request = {
        authorization: {
          context: { tenantId: 'tenant-live', branchId: 'branch-live' },
        },
      };
      interceptor.intercept(fakeContext(request), nextHandler).subscribe(() => {
        const store = context.get();
        expect(store?.tenantId).toBe('tenant-live');
        expect(store?.branchId).toBe('branch-live');
        done();
      });
    });
  });

  it('leaves tenant/branch null when there is no trusted authorization context yet (before tenant context exists)', (done) => {
    const context = new ObservabilityContextService();
    const interceptor = new TenantEnrichmentInterceptor(context);
    context.run(freshStore(), () => {
      interceptor.intercept(fakeContext({}), nextHandler).subscribe(() => {
        const store = context.get();
        expect(store?.tenantId).toBeNull();
        expect(store?.branchId).toBeNull();
        done();
      });
    });
  });

  it('ignores any client-controlled header/body value even if shaped like tenant/branch — only request.authorization.context is read', (done) => {
    const context = new ObservabilityContextService();
    const interceptor = new TenantEnrichmentInterceptor(context);
    context.run(freshStore(), () => {
      const request = {
        headers: { 'x-tenant-id': 'attacker-supplied-tenant' },
        body: {
          tenantId: 'attacker-supplied-tenant',
          branchId: 'attacker-supplied-branch',
        },
        query: { tenantId: 'attacker-supplied-tenant' },
        // no `authorization` — trust boundary not yet established
      };
      interceptor.intercept(fakeContext(request), nextHandler).subscribe(() => {
        const store = context.get();
        expect(store?.tenantId).toBeNull();
        expect(store?.branchId).toBeNull();
        done();
      });
    });
  });
});
