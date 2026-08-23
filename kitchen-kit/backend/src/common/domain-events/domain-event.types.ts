/**
 * Domain event envelope — SRS §5.5.4 ("Every event carries a mandatory
 * envelope"). Field set and names are taken verbatim from the JSON example in
 * §5.5.4: eventId, eventType, eventVersion, occurredAt, recordedAt, tenantId,
 * branchId, actorId, actorType, correlationId, causationId, idempotencyKey,
 * payload.
 *
 * ── WHY `occurredAt`/`recordedAt` ARE `string`, NOT `Date` (P1E-1A correction) ──
 * P1E-1 typed these as `Date`, reasoning that ISO-string serialization was a
 * concern for a future adapter since this mechanism is in-process only. That
 * reasoning did not weigh SRS §5.1 driver 7 (rank 7, "Any module must be
 * extractable later" → consequence: "in-process message bus with a
 * network-ready contract") or §5.2.4's extraction path, whose step 2 is
 * "Replace the in-process event bus binding ... with a network transport" —
 * implying the CONTRACT does not change shape at extraction, only the
 * transport does. A contract that is only network-ready after extraction is
 * not what driver 7 asks for. The source's own §5.5.4 JSON example also
 * renders both fields as ISO-8601 strings
 * (`"occurredAt": "2026-08-04T11:02:33.412Z"`), and the repository's own
 * established convention at every serialization boundary is `.toISOString()`
 * (e.g. `cash-sessions.service.ts`'s audit metadata: `openedAt:
 * session.openedAt.toISOString()`). SOURCE-REQUIRED, not merely a style
 * preference: `occurredAt`/`recordedAt` are ISO-8601 strings on the envelope
 * itself. `CreateDomainEventInput.occurredAt` still takes a `Date` — ergonomic
 * construction matches how every other in-process value in this codebase is
 * handled — and `createDomainEvent()` converts at the boundary where the
 * envelope (the actual public contract) is built.
 *
 * `actorType` here is `'user' | 'system' | 'device'`, exactly the source's
 * `"user|system|device"` — deliberately NOT the repository's existing
 * `AuditActorType` (`'user' | 'anonymous' | 'system' | 'terminal'`, see
 * governance/audit/audit.constants.ts), because the two vocabularies differ
 * and unifying them is not decided by any source read for this slice.
 *
 * ── `correlationId` / `causationId` — P1E-1B CORRECTION ─────────────────────
 * §5.5.4's rationale states plainly what these are FOR: "correlationId ...
 * ties an entire causal chain"; "causationId ... the event/command that caused
 * this". Neither is a per-event free-form field — both identify the event's
 * place in a causal graph, which is exactly what P1E-1/P1E-1A got wrong:
 *
 *   - `correlationId` used to be generated FRESH per event when the caller
 *     omitted it, inside `createDomainEvent()` itself. Two events from the SAME
 *     causal operation could end up with two DIFFERENT correlationIds — which
 *     defeats the field's entire purpose (§5.5.4's own rationale: tracing "an
 *     entire causal chain"). It is NOT typed as optional here for that reason:
 *     the low-level `createDomainEvent()` always requires an explicit value,
 *     and the only thing that may DEFAULT it is `UnitOfWork` — once, per
 *     `execute()` call, not once per event (`unit-of-work.ts`).
 *   - `causationId` used to be nullable, with P1E-1's docblock claiming a root
 *     event "has nothing to reference" — treated as if that were source
 *     policy. It is not: §5.5.4 describes causationId as identifying "the
 *     event/command that caused this", and a root event's cause is real — it
 *     is the command/operation that is currently running. `causationId` is
 *     therefore now REQUIRED and NON-NULLABLE. The low-level API requires the
 *     caller to say what caused it explicitly; `UnitOfWork` defaults it to the
 *     current operation's own identity for a root event, and lets a handler
 *     override it to `parentEvent.eventId` for an explicit child event
 *     (`unit-of-work.ts`, `unit-of-work-context.ts`).
 *
 * Both are typed here exactly as any other required envelope field. The
 * DEFAULTING policy — one correlationId per causal operation; causationId
 * defaulting to the operation's own identity — lives in `UnitOfWork`, not in
 * this type or in `createDomainEvent()`, which stay honest low-level
 * primitives that trust every field the caller supplies.
 */
export type DomainEventActorType = 'user' | 'system' | 'device';

export interface DomainEventEnvelope<
  TType extends string = string,
  TPayload = unknown,
> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly eventVersion: number;
  /** ISO-8601 instant. See the file docblock for why this is a `string`. */
  readonly occurredAt: string;
  /** ISO-8601 instant. See the file docblock for why this is a `string`. */
  readonly recordedAt: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly actorId: string;
  readonly actorType: DomainEventActorType;
  /** Identifies the causal CHAIN this event belongs to. See file docblock. */
  readonly correlationId: string;
  /** Identifies the specific command/event that caused THIS event. See file docblock. */
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<TPayload>;
}

/**
 * Everything a low-level publisher supplies to build one envelope;
 * `eventId` and `recordedAt` are derived by `createDomainEvent()`.
 *
 * This is the INTERNAL construction API (`internal/create-domain-event.ts`,
 * P1E-1B correction) — it trusts every field the caller passes, `tenantId`
 * included, and requires `correlationId`/`causationId` explicitly rather than
 * defaulting either. It exists for contexts with no Unit of Work (pure unit
 * tests of the envelope shape; anything constructing an event outside a
 * transaction) and is NOT importable from `src/modules/**` — enforced by
 * `trusted-construction-boundary.spec.ts`. Business code running inside a
 * `UnitOfWork.execute()` callback must use `ctx.createEvent()` instead
 * (`unit-of-work-context.ts`), which does not let the caller supply
 * `tenantId` or `correlationId` at all, and defaults `causationId` to the
 * current operation's identity — see that file's docblock.
 */
export interface CreateDomainEventInput<TType extends string, TPayload> {
  readonly eventType: TType;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly tenantId: string;
  readonly branchId: string;
  readonly actorId: string;
  readonly actorType: DomainEventActorType;
  readonly correlationId: string;
  readonly causationId: string;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
}
