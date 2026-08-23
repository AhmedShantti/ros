import { DomainEventCollector } from '../domain-event-collector';
import { UnitOfWorkContext } from '../unit-of-work-context';

/**
 * The FULL context — `UnitOfWorkContext` PLUS the raw transaction-scoped
 * event collector. Used only by `UnitOfWork.execute()` (to construct it and
 * drain it after the business callback resolves) and
 * `TransactionalDomainEventDispatcher.drain()` (which needs `.events.drain()`
 * to pull queued events, including ones a handler enqueues via
 * `ctx.publishEvent()` while it runs — §7E nested emission). Both are
 * `common/domain-events` infrastructure; neither is business code.
 *
 * Deliberately kept under `internal/`, alongside the low-level envelope
 * constructor (P1E-1B): `src/modules/**` may not import anything here
 * (`trusted-construction-boundary.spec.ts`), so a business module cannot even
 * NAME this type, let alone construct a fake one and hand it to
 * `TransactionalDomainEventDispatcher.drain()` directly.
 *
 * The object passed to a business callback or a handler IS this exact
 * runtime object — `UnitOfWork.execute()` builds one `InternalUnitOfWorkContext`
 * and passes it everywhere. Only the STATIC TYPE narrows to
 * `UnitOfWorkContext` at the boundary (`fn(ctx)`, `handler.handle(event, ctx)`),
 * which is what makes `ctx.events` a compile error in business/handler code
 * without needing to wrap or proxy the object at runtime.
 */
export interface InternalUnitOfWorkContext extends UnitOfWorkContext {
  readonly events: DomainEventCollector;
}
