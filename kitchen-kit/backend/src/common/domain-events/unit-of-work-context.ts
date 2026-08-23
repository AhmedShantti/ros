import { Prisma } from '../../generated/prisma/client';
import {
  CreateDomainEventInput,
  DomainEventEnvelope,
} from './domain-event.types';

/**
 * What a business publisher may supply to `ctx.publishEvent()` — every
 * `CreateDomainEventInput` field EXCEPT `tenantId` and `correlationId`, NEITHER
 * of which appears in this type at all.
 *
 * `tenantId` — P1E-1A correction: trust-bound to the enclosing `UnitOfWork`'s
 * `AuthScope.tenantId`, impossible for a caller to override (`unit-of-work.ts`).
 *
 * `correlationId` — P1E-1B correction: §5.5.4 describes it as tying "an entire
 * CAUSAL CHAIN", not one event. It is bound to the whole `UnitOfWork.execute()`
 * call, not to any individual event, and cannot be supplied per-event at all —
 * see `unit-of-work.ts`.
 *
 * `causationId` stays present here but becomes OPTIONAL (the base
 * `CreateDomainEventInput.causationId` is required): `UnitOfWork` defaults it
 * to the current operation's own identity for a root event, but a handler MAY
 * override it — e.g. to `parentEvent.eventId` when explicitly publishing a
 * child event caused by the event it is handling (§7, "the correct future
 * shape").
 *
 * `branchId`, `actorId`, `actorType`, and `idempotencyKey` remain REQUIRED,
 * caller-supplied fields — the generic Unit of Work does NOT verify them. See
 * `unit-of-work.ts`'s docblock for exactly why each one cannot be trust-bound
 * today and where a future producer must source it instead.
 */
export type TrustedDomainEventInput<TType extends string, TPayload> = Omit<
  CreateDomainEventInput<TType, TPayload>,
  'tenantId' | 'correlationId' | 'causationId'
> & {
  readonly causationId?: string;
};

/**
 * The function `UnitOfWork.execute` binds into `ctx.publishEvent` — the ONE
 * authoritative publication operation (P1E-1C). It constructs the envelope
 * with trusted metadata bound in, enqueues it in the transaction-scoped
 * collector, and returns the constructed envelope (useful for a handler that
 * wants to point a child event's `causationId` at it). It does NOT dispatch —
 * dispatch happens only when the enclosing `UnitOfWork.execute()` call drains
 * the queue after the business callback/handler chain finishes (§5.5.2).
 */
export type TrustedPublishEvent = <
  TType extends string,
  TPayload extends object,
>(
  input: TrustedDomainEventInput<TType, TPayload>,
) => DomainEventEnvelope<TType, TPayload>;

/**
 * What a Unit-of-Work callback — and every transactional event handler it
 * dispatches to — receives. `tx` is the SAME `Prisma.TransactionClient` for
 * the business write and every subscriber (§5.5.2: "within the same database
 * transaction"); `publishEvent` is the trust-bound envelope constructor AND
 * the queue — see its own type's docblock and `unit-of-work.ts`.
 *
 * ── P1E-1C — WHY THERE IS NO `events` FIELD HERE ────────────────────────────
 * P1E-1A/B trusted `ctx.createEvent()` to CONSTRUCT an envelope correctly, but
 * this type also exposed the raw transaction-scoped collector as `ctx.events`
 * — and `DomainEventCollector.record()` accepts ANY `DomainEventEnvelope`, no
 * questions asked. Since `DomainEventEnvelope` (the TYPE) is legitimately
 * public — Sales/Kitchen contracts need it to type their events — nothing
 * stopped business code from hand-building an object literal satisfying that
 * type (with an arbitrary `tenantId`, a self-chosen `correlationId`, whatever
 * `causationId` it liked) and calling `ctx.events.record(thatObject)`
 * directly, skipping `createEvent`'s trust binding entirely. Closing access to
 * the low-level CONSTRUCTOR (P1E-1B's `internal/create-domain-event.ts`) did
 * nothing to close this — the collector itself was the bypass, because it is
 * where an envelope, however it was built, actually gets queued for dispatch.
 *
 * The fix: `ctx` no longer carries the collector at all. `publishEvent` is now
 * the ONLY operation that can add anything to the queue, and it always builds
 * the envelope itself from trusted inputs — there is no code path by which a
 * caller-constructed object ever reaches `DomainEventCollector.record()`. The
 * collector still exists (`unit-of-work.ts` needs it to drain after `fn`
 * resolves), but only as `InternalUnitOfWorkContext`
 * (`internal/unit-of-work-internal-context.ts`) — a type business code cannot
 * even name, because `src/modules/**` may not import anything under
 * `common/domain-events/internal/` (`trusted-construction-boundary.spec.ts`,
 * extended this correction to also cover `DomainEventCollector` itself and any
 * literal `.events.record(` usage — see that file).
 */
export interface UnitOfWorkContext {
  readonly tx: Prisma.TransactionClient;
  readonly publishEvent: TrustedPublishEvent;
}
