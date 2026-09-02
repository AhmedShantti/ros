import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/**
 * One request/execution's observability context (SRS §27.6 NFR-OBS-001).
 *
 * `tenantId`/`branchId` start `null` and MUST stay `null` until a trusted,
 * server-derived source (live `TenantContextService` resolution — see
 * `RequestAuthorization.context` in `modules/identity/context/tenant-context.ts`)
 * populates them. NEVER populate either from a client-controlled header, the
 * request body, a query string, or a JWT snapshot claim — this codebase's own
 * T-4-LIVE policy already treats the JWT snapshot as unauthoritative, and this
 * context follows the same rule. A field that is not yet known is `null`, not a
 * fabricated placeholder — every consumer (the structured logger, RED metric
 * labels) must handle `null` honestly rather than defaulting to an empty string
 * that could be misread as "known and empty".
 */
export interface ObservabilityStore {
  readonly correlationId: string;
  readonly causationId: string | null;
  tenantId: string | null;
  branchId: string | null;
  /** Normalized route template (e.g. `/orders/:businessDay/:id`), set once the router matches. */
  route: string | null;
  /** Stable `Controller#method` identity, set once the router matches. */
  handler: string | null;
  readonly method: string;
  /** `process.hrtime.bigint()` at request start — for duration measurement. */
  readonly startedAtNs: bigint;
  /** Set by the completion path so a request is never logged/measured twice. */
  completed: boolean;
}

@Injectable()
export class ObservabilityContextService {
  private readonly als = new AsyncLocalStorage<ObservabilityStore>();

  run<T>(store: ObservabilityStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  get(): ObservabilityStore | undefined {
    return this.als.getStore();
  }

  /** Populate route/handler once the router has matched a request to a handler. */
  enrichRoute(route: string, handler: string): void {
    const store = this.als.getStore();
    if (!store) return;
    store.route = route;
    store.handler = handler;
  }

  /**
   * Populate tenant/branch ONLY from a trusted, already-live-verified source.
   * Callers must never pass client-controlled input here.
   */
  enrichTenant(tenantId: string | null, branchId: string | null): void {
    const store = this.als.getStore();
    if (!store) return;
    store.tenantId = tenantId;
    store.branchId = branchId;
  }
}
