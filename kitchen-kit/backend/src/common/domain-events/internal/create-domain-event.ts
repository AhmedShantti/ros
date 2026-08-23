import { newId } from '../../ids';
import {
  CreateDomainEventInput,
  DomainEventEnvelope,
} from '../domain-event.types';

/**
 * Build one envelope (SRS §5.5.4). `eventId` is a fresh ULID (ADR-009, via the
 * repository's existing `newId()` — consistent with every other surrogate key
 * in this codebase). `recordedAt` is the server clock at construction, which is
 * also when it is queued (`DomainEventCollector.record` does not defer this).
 * `occurredAt`/`recordedAt` are converted to ISO-8601 strings here — the input
 * takes a `Date` for ergonomic construction, but the envelope itself (the
 * actual contract) is network-ready per SRS §5.1 driver 7 (see
 * `../domain-event.types.ts`). `payload` is shallow-frozen so a handler
 * cannot mutate what an earlier handler already observed (§10 tenancy/mutation
 * requirement).
 *
 * ── WHY THIS FILE LIVES UNDER `internal/` (P1E-1B correction) ───────────────
 * This function trusts EVERY field the caller supplies, `tenantId` included —
 * that is deliberate (it is the honest low-level primitive `UnitOfWork` builds
 * its trust boundary on top of), but it also means a business module that
 * imported this directly could construct an authoritative envelope claiming
 * an arbitrary tenant, completely bypassing `ctx.createEvent`'s trust binding
 * (`unit-of-work.ts`). `internal/` signals — and
 * `trusted-construction-boundary.spec.ts` mechanically enforces — that nothing
 * under `src/modules/**` (outside its own `.spec.ts` test files, which use
 * this purely to test a contract's shape, never to construct an event a real
 * transaction would see) may import from this directory. Business code MUST
 * go through `ctx.createEvent()`.
 */
export function createDomainEvent<
  TType extends string,
  TPayload extends object,
>(
  input: CreateDomainEventInput<TType, TPayload>,
): DomainEventEnvelope<TType, TPayload> {
  return {
    eventId: newId(),
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    occurredAt: input.occurredAt.toISOString(),
    recordedAt: new Date().toISOString(),
    tenantId: input.tenantId,
    branchId: input.branchId,
    actorId: input.actorId,
    actorType: input.actorType,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: input.idempotencyKey,
    payload: Object.freeze({ ...input.payload }),
  };
}
