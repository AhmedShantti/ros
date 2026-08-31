import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  ModifierKindSnapshot,
  Prisma,
  Ticket,
  TicketFireBatch,
  TicketLine,
} from '../../../generated/prisma/client';
import { TicketHeaderMismatchError } from './ticket-persistence.errors';

export interface GetOrCreateTicketInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly businessDay: Date;
  readonly orderId: string;
  readonly stationId: string;
  readonly orderNumberSnapshot: string;
  readonly orderTypeSnapshot: string;
  readonly serviceReferenceSnapshot: string | null;
  /** FR-KDS-040 "created" — this handler invocation's own instant. */
  readonly createdAt: Date;
  /** FR-KDS-040 "routed" — the Fire command's own instant (payload.firedAt). */
  readonly routedAt: Date;
}

export interface GetOrCreateFireBatchInput {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly fireBatchId: string;
  readonly firedAt: Date;
}

export interface GetOrCreateTicketLineInput {
  readonly tenantId: string;
  readonly ticketId: string;
  readonly fireBatchRowId: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly businessDay: Date;
  readonly itemNameSnapshot: Prisma.InputJsonValue;
  readonly quantity: string;
  readonly course: number | null;
  readonly sequence: number;
  readonly preparationNotes: string | null;
  readonly createdAt: Date;
  readonly routedAt: Date;
}

export interface TicketLineModifierSnapshotInput {
  readonly sourceOrderLineModifierId: string;
  readonly sourceModifierId: string;
  readonly nameSnapshot: Prisma.InputJsonValue;
  readonly kind: ModifierKindSnapshot;
  readonly quantity: number;
}

/**
 * KDS acceptance correction (2026-08-31), Blocker C — `wasCreated`
 * distinguishes a genuinely NEW line (this call's own `INSERT` won) from an
 * idempotent replay (the row already existed, header-verified unchanged).
 * `OrderLineFiredHandler` uses this to decide whether an AMENDMENT fire into
 * an existing Ticket needs to reactivate that Ticket's aggregate — a replay
 * of the SAME fired line must never do so.
 */
export interface GetOrCreateTicketLineResult {
  readonly line: TicketLine;
  readonly wasCreated: boolean;
}

/**
 * Private Kitchen persistence — the ONLY code in this repository that writes
 * `kitchen.tickets` / `ticket_fire_batches` / `ticket_lines` /
 * `ticket_line_modifiers`. Every method is idempotent: replaying the same
 * `order.line.fired` event (or the same Fire command's several line events)
 * converges on the same rows rather than duplicating them (P1E-5
 * §19.2-19.4).
 *
 * ── P1E-5A CORRECTION — WHY THIS IS `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING ...`, NOT "try create(), catch P2002" ─────────────────────────
 * P1E-5's first draft caught the Prisma P2002 error from a losing `create()`
 * and then issued a `findUniqueOrThrow` in the SAME transaction to fetch the
 * winner's row. That does not work: PostgreSQL marks a transaction ABORTED
 * the instant any statement inside it raises a real database error (a
 * unique-violation included) — Prisma's interactive `$transaction` callback
 * does not wrap each individual query in its own `SAVEPOINT`, so catching
 * the JS exception does nothing to un-abort the underlying SQL transaction.
 * Every statement issued afterwards — including the "recovery" `findUnique`
 * — fails with `25P02 current transaction is aborted, commands ignored
 * until end of transaction block`, which is not a `P2002` and therefore
 * re-thrown, so a losing race did not converge on the winner; it just failed
 * differently. Proven directly against real PostgreSQL (see the P1E-5A
 * report §C) and by the concurrency tests added for this correction
 * (`kitchen-ticket-concurrency.e2e-spec.ts`) — none of P1E-5's own tests
 * exercised this path, because every one of them replayed sequentially
 * through separate `UnitOfWork.execute()` calls, each its own transaction:
 * the SECOND call's `findUnique` always saw the FIRST call's already-
 * committed row and returned early, never reaching the `create()` branch at
 * all.
 *
 * The fix: an atomic `INSERT ... ON CONFLICT (<natural key>) DO NOTHING
 * RETURNING ...`. PostgreSQL resolves the conflict INSIDE the statement —
 * no exception is raised for the expected race, so the transaction is never
 * put into an aborted state. If the insert returns a row, that row was just
 * created by THIS call. If it returns no row, some other transaction won the
 * race; a plain `SELECT` (which raises nothing, because there is no
 * conflict in a `SELECT`) fetches the winner. Every query here still runs
 * through the SAME `Prisma.TransactionClient` the caller supplied — no
 * second transaction, no retry framework, no savepoint machinery added.
 * Parameters are bound via Prisma's tagged-template `$queryRaw`/`$executeRaw`
 * (never `$queryRawUnsafe`/string concatenation) — the same protection
 * against injection an ordinary Prisma query gets.
 *
 * Any OTHER database error (a genuine FK violation, a CHECK violation, a
 * connection failure) is not a conflict this class expects and is never
 * caught — it propagates and rolls back the whole Fire transaction, exactly
 * as before.
 */
@Injectable()
export class TicketPersistenceService {
  async getOrCreateTicket(
    tx: Prisma.TransactionClient,
    input: GetOrCreateTicketInput,
  ): Promise<Ticket> {
    const id = newId();
    const inserted = await tx.$queryRaw<Ticket[]>`
      INSERT INTO "kitchen"."tickets" (
        "id", "tenant_id", "branch_id", "business_day", "order_id", "station_id",
        "order_number_snapshot", "order_type_snapshot", "service_reference_snapshot",
        "created_at", "routed_at"
      ) VALUES (
        ${id}::uuid, ${input.tenantId}::uuid, ${input.branchId}::uuid,
        ${input.businessDay}::date, ${input.orderId}::uuid, ${input.stationId}::uuid,
        ${input.orderNumberSnapshot}, ${input.orderTypeSnapshot},
        ${input.serviceReferenceSnapshot}, ${input.createdAt}::timestamptz,
        ${input.routedAt}::timestamptz
      )
      ON CONFLICT ("tenant_id", "order_id", "business_day", "station_id") DO NOTHING
      RETURNING
        "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
        "business_day" AS "businessDay", "order_id" AS "orderId",
        "station_id" AS "stationId",
        "order_number_snapshot" AS "orderNumberSnapshot",
        "order_type_snapshot" AS "orderTypeSnapshot",
        "service_reference_snapshot" AS "serviceReferenceSnapshot",
        "status", "version",
        "created_at" AS "createdAt", "routed_at" AS "routedAt",
        "first_viewed_at" AS "firstViewedAt", "started_at" AS "startedAt",
        "ready_at" AS "readyAt", "bumped_at" AS "bumpedAt",
        "served_at" AS "servedAt", "target_ready_at" AS "targetReadyAt",
        "recalled_at" AS "recalledAt", "recall_count" AS "recallCount",
        "started_by" AS "startedBy", "bumped_by" AS "bumpedBy"
    `;
    if (inserted.length > 0) {
      return inserted[0];
    }

    // Lost the race (or this is a genuine replay of an already-fired line) —
    // no exception was raised, so `tx` is still perfectly usable.
    const existingRows = await tx.$queryRaw<Ticket[]>`
      SELECT
        "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
        "business_day" AS "businessDay", "order_id" AS "orderId",
        "station_id" AS "stationId",
        "order_number_snapshot" AS "orderNumberSnapshot",
        "order_type_snapshot" AS "orderTypeSnapshot",
        "service_reference_snapshot" AS "serviceReferenceSnapshot",
        "status", "version",
        "created_at" AS "createdAt", "routed_at" AS "routedAt",
        "first_viewed_at" AS "firstViewedAt", "started_at" AS "startedAt",
        "ready_at" AS "readyAt", "bumped_at" AS "bumpedAt",
        "served_at" AS "servedAt", "target_ready_at" AS "targetReadyAt",
        "recalled_at" AS "recalledAt", "recall_count" AS "recallCount",
        "started_by" AS "startedBy", "bumped_by" AS "bumpedBy"
      FROM "kitchen"."tickets"
      WHERE "tenant_id" = ${input.tenantId}::uuid
        AND "order_id" = ${input.orderId}::uuid
        AND "business_day" = ${input.businessDay}::date
        AND "station_id" = ${input.stationId}::uuid
    `;
    const existing = existingRows[0];
    if (!existing) {
      // RLS made the winner's row invisible to this session (different
      // tenant context) or it was concurrently deleted — neither is a
      // supported state; surface it rather than fabricating a row.
      throw new Error(
        `Ticket insert conflicted for (tenant=${input.tenantId}, order=` +
          `${input.orderId}, station=${input.stationId}) but no row is ` +
          'visible afterwards.',
      );
    }
    this.assertHeaderUnchanged(existing, input);
    return existing;
  }

  private assertHeaderUnchanged(
    existing: Ticket,
    incoming: GetOrCreateTicketInput,
  ): void {
    if (
      existing.orderNumberSnapshot !== incoming.orderNumberSnapshot ||
      existing.orderTypeSnapshot !== incoming.orderTypeSnapshot ||
      existing.serviceReferenceSnapshot !== incoming.serviceReferenceSnapshot
    ) {
      throw new TicketHeaderMismatchError(
        `Ticket ${existing.id} (order ${incoming.orderId}, station ` +
          `${incoming.stationId}) already has a different immutable header ` +
          'snapshot than the incoming event. Refusing to overwrite.',
      );
    }
  }

  async getOrCreateFireBatch(
    tx: Prisma.TransactionClient,
    input: GetOrCreateFireBatchInput,
  ): Promise<TicketFireBatch> {
    const id = newId();
    const inserted = await tx.$queryRaw<TicketFireBatch[]>`
      INSERT INTO "kitchen"."ticket_fire_batches" (
        "id", "tenant_id", "ticket_id", "fire_batch_id", "fired_at"
      ) VALUES (
        ${id}::uuid, ${input.tenantId}::uuid, ${input.ticketId}::uuid,
        ${input.fireBatchId}::uuid, ${input.firedAt}::timestamptz
      )
      ON CONFLICT ("tenant_id", "ticket_id", "fire_batch_id") DO NOTHING
      RETURNING
        "id", "tenant_id" AS "tenantId", "ticket_id" AS "ticketId",
        "fire_batch_id" AS "fireBatchId", "fired_at" AS "firedAt",
        "created_at" AS "createdAt"
    `;
    if (inserted.length > 0) {
      return inserted[0];
    }

    const existingRows = await tx.$queryRaw<TicketFireBatch[]>`
      SELECT
        "id", "tenant_id" AS "tenantId", "ticket_id" AS "ticketId",
        "fire_batch_id" AS "fireBatchId", "fired_at" AS "firedAt",
        "created_at" AS "createdAt"
      FROM "kitchen"."ticket_fire_batches"
      WHERE "tenant_id" = ${input.tenantId}::uuid
        AND "ticket_id" = ${input.ticketId}::uuid
        AND "fire_batch_id" = ${input.fireBatchId}::uuid
    `;
    const existing = existingRows[0];
    if (!existing) {
      throw new Error(
        `TicketFireBatch insert conflicted for (tenant=${input.tenantId}, ` +
          `ticket=${input.ticketId}, fireBatch=${input.fireBatchId}) but no ` +
          'row is visible afterwards.',
      );
    }
    return existing;
  }

  async getOrCreateTicketLine(
    tx: Prisma.TransactionClient,
    input: GetOrCreateTicketLineInput,
  ): Promise<GetOrCreateTicketLineResult> {
    const id = newId();
    const inserted = await tx.$queryRaw<TicketLine[]>`
      INSERT INTO "kitchen"."ticket_lines" (
        "id", "tenant_id", "ticket_id", "fire_batch_row_id", "order_id",
        "order_line_id", "business_day", "item_name_snapshot", "quantity",
        "course", "sequence", "preparation_notes", "created_at", "routed_at"
      ) VALUES (
        ${id}::uuid, ${input.tenantId}::uuid, ${input.ticketId}::uuid,
        ${input.fireBatchRowId}::uuid, ${input.orderId}::uuid,
        ${input.orderLineId}::uuid, ${input.businessDay}::date,
        ${JSON.stringify(input.itemNameSnapshot)}::jsonb,
        ${input.quantity}::decimal(12,3),
        ${input.course}::smallint, ${input.sequence}::smallint,
        ${input.preparationNotes}, ${input.createdAt}::timestamptz,
        ${input.routedAt}::timestamptz
      )
      ON CONFLICT ("tenant_id", "ticket_id", "order_line_id") DO NOTHING
      RETURNING
        "id", "tenant_id" AS "tenantId", "ticket_id" AS "ticketId",
        "fire_batch_row_id" AS "fireBatchRowId", "order_id" AS "orderId",
        "order_line_id" AS "orderLineId", "business_day" AS "businessDay",
        "item_name_snapshot" AS "itemNameSnapshot", "quantity", "course",
        "sequence", "preparation_notes" AS "preparationNotes", "status",
        "created_at" AS "createdAt", "routed_at" AS "routedAt",
        "first_viewed_at" AS "firstViewedAt", "started_at" AS "startedAt",
        "ready_at" AS "readyAt", "bumped_at" AS "bumpedAt",
        "served_at" AS "servedAt", "cancelled_at" AS "cancelledAt",
        "recalled_at" AS "recalledAt", "started_by" AS "startedBy",
        "bumped_by" AS "bumpedBy"
    `;
    if (inserted.length > 0) {
      return { line: inserted[0], wasCreated: true };
    }

    const existingRows = await tx.$queryRaw<TicketLine[]>`
      SELECT
        "id", "tenant_id" AS "tenantId", "ticket_id" AS "ticketId",
        "fire_batch_row_id" AS "fireBatchRowId", "order_id" AS "orderId",
        "order_line_id" AS "orderLineId", "business_day" AS "businessDay",
        "item_name_snapshot" AS "itemNameSnapshot", "quantity", "course",
        "sequence", "preparation_notes" AS "preparationNotes", "status",
        "created_at" AS "createdAt", "routed_at" AS "routedAt",
        "first_viewed_at" AS "firstViewedAt", "started_at" AS "startedAt",
        "ready_at" AS "readyAt", "bumped_at" AS "bumpedAt",
        "served_at" AS "servedAt", "cancelled_at" AS "cancelledAt",
        "recalled_at" AS "recalledAt", "started_by" AS "startedBy",
        "bumped_by" AS "bumpedBy"
      FROM "kitchen"."ticket_lines"
      WHERE "tenant_id" = ${input.tenantId}::uuid
        AND "ticket_id" = ${input.ticketId}::uuid
        AND "order_line_id" = ${input.orderLineId}::uuid
    `;
    const existing = existingRows[0];
    if (!existing) {
      throw new Error(
        `TicketLine insert conflicted for (tenant=${input.tenantId}, ` +
          `ticket=${input.ticketId}, orderLine=${input.orderLineId}) but no ` +
          'row is visible afterwards.',
      );
    }
    // P1E-5A: the narrowest invariant symmetric with the Ticket header check
    // (§4/§6) — a line that already exists must be the SAME captured fact,
    // never silently reused with different content. No schema change; this
    // mirrors `assertHeaderUnchanged` exactly, scoped to TicketLine's own
    // immutable snapshot fields.
    if (
      JSON.stringify(existing.itemNameSnapshot) !==
        JSON.stringify(input.itemNameSnapshot) ||
      existing.quantity.toString() !== input.quantity ||
      existing.course !== input.course ||
      existing.sequence !== input.sequence ||
      existing.preparationNotes !== input.preparationNotes
    ) {
      throw new TicketHeaderMismatchError(
        `TicketLine ${existing.id} (ticket ${input.ticketId}, order line ` +
          `${input.orderLineId}) already has different immutable snapshot ` +
          'content than the incoming event. Refusing to overwrite.',
      );
    }
    return { line: existing, wasCreated: false };
  }

  async ensureTicketLineModifier(
    tx: Prisma.TransactionClient,
    tenantId: string,
    ticketLineId: string,
    input: TicketLineModifierSnapshotInput,
  ): Promise<void> {
    const id = newId();
    await tx.$executeRaw`
      INSERT INTO "kitchen"."ticket_line_modifiers" (
        "id", "tenant_id", "ticket_line_id", "source_order_line_modifier_id",
        "source_modifier_id", "name_snapshot", "kind", "quantity"
      ) VALUES (
        ${id}::uuid, ${tenantId}::uuid, ${ticketLineId}::uuid,
        ${input.sourceOrderLineModifierId}::uuid,
        ${input.sourceModifierId}::uuid,
        ${JSON.stringify(input.nameSnapshot)}::jsonb,
        ${input.kind}::"kitchen"."ModifierKindSnapshot",
        ${input.quantity}::smallint
      )
      ON CONFLICT ("tenant_id", "ticket_line_id", "source_order_line_modifier_id")
      DO NOTHING
    `;
    // No RETURNING needed — a second call for the identical (ticketLine,
    // sourceOrderLineModifierId) is a pure idempotent no-op either way, and
    // this method's contract (§19.4/§7) never reports which case occurred.
  }
}
