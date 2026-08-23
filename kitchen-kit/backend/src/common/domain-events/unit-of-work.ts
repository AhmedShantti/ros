import { Injectable } from '@nestjs/common';
import { newId } from '../ids';
import { AuthScope, PrismaService } from '../../prisma/prisma.service';
import { createDomainEvent } from './internal/create-domain-event';
import { InternalUnitOfWorkContext } from './internal/unit-of-work-internal-context';
import { DomainEventCollector } from './domain-event-collector';
import { TransactionalDomainEventDispatcher } from './domain-event-dispatcher';
import { UnitOfWorkContext } from './unit-of-work-context';

/**
 * What a Unit of Work may INHERIT from whatever caused it to run. Both fields
 * are optional: omitting `correlationId` starts a NEW causal chain (a fresh
 * ULID); omitting `causationId` means this operation has no prior cause other
 * than itself (its own freshly-generated command identity becomes the default
 * causation for its root events — see `execute()` below).
 *
 * This is how a FUTURE caller expresses "this operation is itself a step in an
 * existing causal chain" — e.g. a process manager reacting to `parentEvent`
 * would call `unitOfWork.execute(scope, fn, { correlationId:
 * parentEvent.correlationId, causationId: parentEvent.eventId })`. Nothing in
 * this repository does that yet; the shape exists so it can, without a
 * breaking change, per §6's "the API must support the correct future shape."
 */
export interface UnitOfWorkCausalContext {
  readonly correlationId?: string;
  readonly causationId?: string;
}

/**
 * The narrowest composable Unit of Work around the existing transaction
 * primitive (`PrismaService.withAuthContext`).
 *
 * `PrismaService.withAuthContext` already IS the transaction boundary — it
 * opens one `$transaction`, sets the RLS-consumed tenant context as its first
 * statement, and runs the callback inside it. Its own docblock states nested
 * calls are unsupported ("Prisma has no nested interactive transactions;
 * compose within a single scope instead"), so this class does not wrap it in a
 * second transaction; it runs INSIDE the same callback:
 *
 *   1. call `fn` with a fresh `{ tx, publishEvent }` context (statically
 *      narrowed from the fuller `InternalUnitOfWorkContext` this class
 *      actually builds — see P1E-1C below) — `tx` is the same
 *      `Prisma.TransactionClient` `withAuthContext` already provides;
 *   2. after `fn` resolves, drain the internal collector through the
 *      dispatcher, using the SAME underlying context object (so handlers get
 *      the same `tx` and can themselves publish further events into the same
 *      collector — §7E);
 *   3. only then does this callback return, which is what lets
 *      `withAuthContext`'s own `$transaction` commit.
 *
 * A handler's rejection propagates out of `drain`, out of this callback,
 * causing `$transaction` to roll back the whole thing — business write and
 * every subscriber write together (§5.5.2, §12).
 *
 * This does not replace `withAuthContext`: existing services keep calling it
 * directly. `UnitOfWork.execute` is for a future command that needs the event
 * mechanism; nothing in this slice is migrated onto it (§8: "Do not rewrite
 * every service to use the new UoW in this slice").
 *
 * ── P1E-1A — TRUSTED TENANT (`ctx.publishEvent`) ─────────────────────────────
 * `ctx.publishEvent`'s input type (`TrustedDomainEventInput`) does not declare
 * a `tenantId` property at all, and the implementation below ALWAYS supplies
 * `scope.tenantId` itself — spread `input` first, then overwrite `tenantId`
 * last, so even a caller that defeats the type system (`as any`) cannot make a
 * different value survive into the envelope, because there is no code path
 * that reads `tenantId` off `input` in the first place. Checked against
 * `AuthScope` (`prisma.service.ts`), the ONLY thing a generic Unit of Work
 * actually has: `{ userId?: string; tenantId?: string }`. `branchId` /
 * `actorId` / `actorType` stay required, UNVERIFIED `ctx.publishEvent` inputs —
 * `AuthScope` carries neither, and this repository's actor-typed context
 * (`current-principal.decorator.ts`, `pos-session.decorator.ts`) lives only at
 * the HTTP layer, which a generic Unit of Work must not depend on (that would
 * make `common/domain-events` depend on `identity`). A future producer must
 * pass its own already-trusted values through, exactly as
 * `CashSessionsService.open` already does for
 * `actorUserId`/`employeeId`/`terminalId`, and (for `branchId`) exactly as it
 * derives `branch.id` from `terminal.branchId`, never from a request body.
 *
 * ── P1E-1B — CAUSAL CONTEXT (`correlationId` / `causationId`) ───────────────
 * `correlationId` is resolved EXACTLY ONCE per `execute()` call — either
 * inherited (`causal.correlationId`) or freshly generated — and is not a
 * `ctx.publishEvent` input at all. Every event this Unit of Work publishes
 * shares the SAME correlationId. `commandId` — this call's own operation
 * identity — is always freshly generated and is NOT itself part of the public
 * envelope; it exists only to be the default `causationId` for this
 * operation's root events (`defaultCausationId = causal.causationId ??
 * commandId`). A handler wanting to express "this new event was caused by the
 * specific parent event I am handling" may explicitly pass `causationId:
 * parentEvent.eventId` to `ctx.publishEvent` — deliberately NOT automatic.
 *
 * ── P1E-1C — ONE AUTHORITATIVE PUBLICATION PATH (`ctx.publishEvent`) ────────
 * P1E-1B closed the LOW-LEVEL construction bypass (`internal/create-domain-event.ts`
 * became unreachable from `src/modules/**`), but `ctx.createEvent()` only
 * BUILT an envelope — the caller still had to call `ctx.events.record(...)`
 * separately to queue it, and `ctx.events` was a plain `DomainEventCollector`
 * whose `record()` method accepts ANY `DomainEventEnvelope`. Since that TYPE
 * is legitimately public (Sales/Kitchen contracts need it), nothing stopped
 * business code from hand-building a fake envelope — arbitrary `tenantId`,
 * self-chosen `correlationId`/`causationId` — and calling
 * `ctx.events.record(fake)` directly, completely bypassing every trust
 * guarantee above. `createEvent` and `events` are both gone from
 * `UnitOfWorkContext` (`unit-of-work-context.ts`) now. `publishEvent` is the
 * ONLY operation exposed: it builds the envelope from trusted inputs AND
 * enqueues it, in one call, so there is no intermediate "envelope I already
 * built, now let me queue it" step for a caller-built object to be substituted
 * into. It does not dispatch — dispatch is still `dispatcher.drain()`, called
 * only after `fn` resolves.
 *
 * ── IDEMPOTENCY KEY — NOT SOURCE-DECIDABLE ───────────────────────────────────
 * The SRS envelope names the `idempotencyKey` field; nothing in the source
 * establishes whether it is, is not, or is derived from the HTTP layer's
 * `Idempotency-Key` (`common/idempotency/`). That relationship remains
 * genuinely **NOT SOURCE-DECIDABLE** until the first real producer (Fire)
 * establishes what command boundary an event's key should be scoped to.
 * `ctx.publishEvent` still requires it explicitly and never fabricates one.
 */
@Injectable()
export class UnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: TransactionalDomainEventDispatcher,
  ) {}

  async execute<T>(
    scope: AuthScope,
    fn: (ctx: UnitOfWorkContext) => Promise<T>,
    causal: UnitOfWorkCausalContext = {},
  ): Promise<T> {
    const correlationId = causal.correlationId ?? newId();
    // This operation's own identity — always fresh, regardless of inheritance.
    const commandId = newId();
    const defaultCausationId = causal.causationId ?? commandId;

    return this.prisma.withAuthContext(scope, async (tx) => {
      const events = new DomainEventCollector();
      const publishEvent: UnitOfWorkContext['publishEvent'] = (input) => {
        if (!scope.tenantId) {
          throw new Error(
            'UnitOfWork.publishEvent requires a tenantId in the AuthScope ' +
              'this Unit of Work was opened with; this UoW has none.',
          );
        }
        const event = createDomainEvent({
          ...input,
          // ALWAYS the trusted values, applied LAST — see the class docblock.
          tenantId: scope.tenantId,
          correlationId,
          causationId: input.causationId ?? defaultCausationId,
        });
        events.record(event);
        return event;
      };
      const ctx: InternalUnitOfWorkContext = { tx, events, publishEvent };
      const result = await fn(ctx);
      await this.dispatcher.drain(ctx);
      return result;
    });
  }
}
