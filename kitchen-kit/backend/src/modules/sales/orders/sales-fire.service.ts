import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { UnitOfWork } from '../../../common/domain-events/unit-of-work';
import { Order, OrderLine, Prisma } from '../../../generated/prisma/client';
import { CATALOGUE_FIRE_FACTS_QUERY } from '../../catalogue/contract';
import type { CatalogueFireFactsQuery } from '../../catalogue/contract';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { TABLE_DISPLAY_QUERY } from '../../organisation/contract';
import type { TableDisplayQuery } from '../../organisation/contract';
import {
  ORDER_LINE_FIRED_EVENT_TYPE,
  ORDER_LINE_FIRED_EVENT_VERSION,
  ORDER_OPENED_EVENT_TYPE,
  ORDER_OPENED_EVENT_VERSION,
  OrderLineFiredModifier,
  OrderLineFiredModifierKind,
} from '../contract';
import {
  IllegalFireSourceStateError,
  NoEligibleLinesToFireError,
  UnresolvedModifierKindError,
  UnresolvedServiceReferenceError,
} from './fire.errors';
import {
  OrderVersionConflictError,
  assertMayFire,
  assertTransition,
  assertVersion,
  isFinalised,
} from './order-state';

export interface FireOrderInput {
  readonly orderId: string;
  readonly businessDay: Date;
  readonly expectedVersion: number;
  readonly actorUserId: string;
  readonly terminalId: string;
}

export interface FireOrderResult {
  readonly order: Order & { lines: OrderLine[] };
  readonly firedLineIds: readonly string[];
}

type LoadedLine = OrderLine & {
  modifiers: Prisma.OrderLineModifierGetPayload<Record<string, never>>[];
  stationOverrides: Prisma.OrderLineStationOverrideGetPayload<
    Record<string, never>
  >[];
};

/**
 * Sales application command — explicit Fire (P1E-6).
 *
 * PRIVATE to Sales: not exported through `sales/contract` (the task's own
 * §7 instruction — the contract exposes only the event TYPES Kitchen
 * consumes, never a Sales command). Owns everything the controller must not:
 * loading the aggregate, validating expected version, determining eligible
 * lines, validating Fire state, collecting Catalogue/Organisation Fire-facts,
 * mutating Sales state, writing audit, and publishing `order.opened` /
 * `order.line.fired` — all inside the ONE `UnitOfWork.execute()` transaction
 * that also lets Kitchen's existing `OrderLineFiredHandler` run synchronously
 * before commit (SRS §5.5.1/§5.5.2).
 *
 * Reuses `order-state.ts`'s existing `assertMayFire`/`assertTransition`/
 * `assertVersion` verbatim — no second state machine, no broadened states.
 *
 * ── ROUTING-FAILURE HTTP MAPPING ─────────────────────────────────────────
 * `RoutingNoDestinationError`/`RoutingConfigurationConflictError`
 * (`kitchen/routing/routing-resolver.errors.ts`) are, by that file's own
 * docblock, "ordinary Error subclasses ... no HTTP framing here ... a future
 * caller (Fire) maps `code` to whatever transport-level error shape it
 * needs." Sales must not import a Kitchen private path (§25 forbids
 * `Sales -> Kitchen internal`), so the mapping here is duck-typed on the
 * error's own stable `code` discriminant (`ROUTING_NO_DESTINATION` /
 * `ROUTING_CONFIGURATION_CONFLICT`) rather than an `instanceof` check against
 * an imported class. By the time this catch runs, `UnitOfWork.execute`'s
 * enclosing `$transaction` has already rolled back everything the command
 * and Kitchen's handler wrote — the re-throw only changes the HTTP shape,
 * never re-attempts or partially preserves anything.
 */
@Injectable()
export class SalesFireService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditService,
    @Inject(CATALOGUE_FIRE_FACTS_QUERY)
    private readonly catalogueFireFacts: CatalogueFireFactsQuery,
    @Inject(TABLE_DISPLAY_QUERY)
    private readonly tableDisplay: TableDisplayQuery,
  ) {}

  async fire(
    tenantId: string,
    input: FireOrderInput,
  ): Promise<FireOrderResult> {
    try {
      return await this.unitOfWork.execute(
        { userId: input.actorUserId, tenantId },
        async (ctx) => {
          const order = await ctx.tx.order.findUnique({
            where: {
              id_businessDay: {
                id: input.orderId,
                businessDay: input.businessDay,
              },
            },
            include: {
              lines: {
                orderBy: { sequence: 'asc' },
                include: { modifiers: true, stationOverrides: true },
              },
            },
          });
          if (!order) throw new NotFoundException('Order not found.');

          // P1E-6A Defect B: the MVP explicit Fire command only supports
          // draft->open (first Fire) and open->open (amendment Fire) — a
          // finalised order still falls through to `assertMayFire`'s own
          // BR-POS-001 message below, unchanged.
          if (
            order.state !== 'draft' &&
            order.state !== 'open' &&
            !isFinalised(order.state)
          ) {
            throw new IllegalFireSourceStateError(
              `Order is ${order.state}; Fire is only supported from draft or open in this release. ` +
                'Resume the order to open before firing.',
            );
          }
          assertMayFire(order.state, order.orderType, order.tableId);
          const nextVersion = assertVersion(
            order.version,
            input.expectedVersion,
          );

          const eligibleLines = order.lines.filter(
            (l): l is LoadedLine => l.state === 'pending',
          );
          if (eligibleLines.length === 0) {
            throw new NoEligibleLinesToFireError(
              'There are no pending lines to fire (ENGINEERING-DECIDED: the SRS ' +
                'does not define a successful empty Fire).',
            );
          }
          for (const line of eligibleLines) {
            for (const modifier of line.modifiers) {
              if (modifier.kindSnapshot === null) {
                throw new UnresolvedModifierKindError(
                  `Order line ${line.id} carries a modifier (${modifier.id}) with an ` +
                    'unresolved kind (FR-POS-021); Fire cannot proceed for the whole command.',
                );
              }
            }
          }

          // ── ONE fire instant, ONE fire batch id, for the WHOLE command ──
          const fireInstant = new Date();
          const fireBatchId = newId();
          const isFirstFire = order.state === 'draft';
          if (isFirstFire) assertTransition('draft', 'open');
          const newState = isFirstFire ? 'open' : order.state;

          // ── Catalogue Fire-facts, batched across every distinct menuItemId ──
          const menuItemIds = [
            ...new Set(eligibleLines.map((l) => l.menuItemId)),
          ];
          const catalogueFacts = await this.catalogueFireFacts.find(ctx.tx, {
            tenantId,
            menuItemIds,
          });

          // ── Organisation table display — dine-in only, honest null otherwise ──
          //
          // P1E-6A Defect C: a `tableId` that is present but does not
          // resolve (deleted, or belongs to another tenant — the public
          // contract is itself tenant-scoped) is a data-integrity problem,
          // not the "no table yet" case `assertMayFire` already rejects via
          // `tableId === null`. Fail CLOSED instead of silently firing with
          // `serviceReference: null`.
          let serviceReference: string | null = null;
          if (order.orderType === 'dine_in' && order.tableId) {
            const table = await this.tableDisplay.find(ctx.tx, {
              tenantId,
              tableId: order.tableId,
            });
            if (!table) {
              throw new UnresolvedServiceReferenceError(
                `Order ${order.id} references table ${order.tableId}, which does not resolve. ` +
                  'Fire cannot proceed with an unresolvable dine-in table assignment.',
              );
            }
            serviceReference = table.label;
          }

          // ── Mutate Order ──────────────────────────────────────────────
          //
          // The version guard is enforced HERE, atomically, in the UPDATE's
          // own WHERE clause — not only by the earlier `assertVersion` read
          // check. `assertVersion` reads-then-decides in application code,
          // which is correct for a single caller but is NOT by itself safe
          // under two genuinely concurrent transactions: under READ
          // COMMITTED, two transactions can both SELECT the same starting
          // version before either commits, both pass the read-time check,
          // and (since the existing repo-wide `order.update()` convention
          // this method would otherwise copy targets the row by id/business
          // day only, never by version) the second writer would silently
          // overwrite the first's committed change with its own
          // stale-computed `nextVersion` once its blocked UPDATE is
          // unblocked — a lost update, and for Fire specifically a
          // duplicated Kitchen consequence (P1E-6 §10/§22 requires exactly
          // one winner). `updateMany` with `version` IN the WHERE clause
          // makes the compare-and-swap atomic: at most one concurrent
          // transaction's UPDATE can match a still-current version, so at
          // most one can ever affect a row — the second observes `count:
          // 0` and fails through the SAME `OrderVersionConflictError` /
          // 409 path `assertVersion` already produces for the sequential
          // case, not a new error shape.
          const updateResult = await ctx.tx.order.updateMany({
            where: {
              id: order.id,
              businessDay: order.businessDay,
              version: input.expectedVersion,
            },
            data: {
              state: newState as never,
              version: nextVersion,
              ...(isFirstFire ? { firstFiredAt: fireInstant } : {}),
              updatedAt: new Date(),
            },
          });
          if (updateResult.count === 0) {
            throw new OrderVersionConflictError(
              `Version mismatch: the order changed concurrently and is no longer at version ${input.expectedVersion}. ` +
                'Reload the order and retry.',
            );
          }

          // ── Mutate lines — every eligible line, SAME fireInstant ────────
          for (const line of eligibleLines) {
            await ctx.tx.orderLine.update({
              where: {
                id_businessDay: { id: line.id, businessDay: line.businessDay },
              },
              data: { state: 'fired', firedAt: fireInstant },
            });
          }

          // ── Audit — same transaction ────────────────────────────────────
          await this.audit.record(ctx.tx, {
            tenantId,
            action: AUDIT_ACTION.ORDER_FIRED,
            entityType: AUDIT_ENTITY.ORDER,
            actorType: 'user',
            actorId: input.actorUserId,
            entityId: order.id,
            terminalId: input.terminalId,
            before: { state: order.state, version: order.version },
            metadata: {
              state: newState,
              version: nextVersion,
              branchId: order.branchId,
              fireBatchId,
              firedLineIds: eligibleLines.map((l) => l.id),
              firstFire: isFirstFire,
            },
          });

          // ── order.opened — first Fire only ──────────────────────────────
          if (isFirstFire) {
            ctx.publishEvent({
              eventType: ORDER_OPENED_EVENT_TYPE,
              eventVersion: ORDER_OPENED_EVENT_VERSION,
              occurredAt: fireInstant,
              branchId: order.branchId,
              actorId: input.actorUserId,
              actorType: 'user',
              idempotencyKey: `fire:${fireBatchId}:opened`,
              payload: {
                orderId: order.id,
                businessDay: order.businessDay.toISOString().slice(0, 10),
                orderNumber: order.orderNumber,
                orderType: order.orderType,
                channel: order.channel,
                openedAt: fireInstant.toISOString(),
              },
            });
          }

          // ── order.line.fired — one per newly-fired line ─────────────────
          for (const line of eligibleLines) {
            const facts = catalogueFacts.get(line.menuItemId);
            const modifiers: OrderLineFiredModifier[] = line.modifiers.map(
              (modifier) => ({
                orderLineModifierId: modifier.id,
                modifierId: modifier.modifierId,
                nameSnapshot: modifier.nameSnapshot as Record<string, unknown>,
                // Non-null: verified above, before any mutation.
                kind: modifier.kindSnapshot as OrderLineFiredModifierKind,
                quantity: modifier.quantity,
              }),
            );

            ctx.publishEvent({
              eventType: ORDER_LINE_FIRED_EVENT_TYPE,
              eventVersion: ORDER_LINE_FIRED_EVENT_VERSION,
              occurredAt: fireInstant,
              branchId: order.branchId,
              actorId: input.actorUserId,
              actorType: 'user',
              idempotencyKey: `fire:${fireBatchId}:${line.id}`,
              payload: {
                orderId: order.id,
                businessDay: order.businessDay.toISOString().slice(0, 10),
                orderLineId: line.id,
                fireBatchId,
                firedAt: fireInstant.toISOString(),
                menuItemId: line.menuItemId,
                modifierIds: line.modifiers.map((m) => m.modifierId),
                categoryIds: facts?.categoryIds ?? [],
                lineStationOverrides: line.stationOverrides.map((o) => ({
                  overrideId: o.id,
                  stationId: o.stationId,
                })),
                orderNumber: order.orderNumber,
                orderType: order.orderType,
                serviceReference,
                // ENGINEERING DECISION (P1E-6 §12): the persisted Sales
                // OrderLine snapshot is never rewritten; the EVENT's own
                // itemNameSnapshot additionally carries the Catalogue
                // kitchen/KDS name (or honest `null`) under `kitchenName`,
                // inside the same flexible `Record<string, unknown>` the
                // frozen P1E-5 contract already declares — no contract
                // redesign, no new field.
                itemNameSnapshot: {
                  ...(line.itemNameSnapshot as Record<string, unknown>),
                  kitchenName: facts?.kitchenName ?? null,
                },
                quantity: line.quantity.toString(),
                course: line.course,
                sequence: line.sequence,
                preparationNotes: line.notes,
                modifiers,
              },
            });
          }

          const finalOrder = await ctx.tx.order.findUnique({
            where: {
              id_businessDay: { id: order.id, businessDay: order.businessDay },
            },
            include: { lines: { orderBy: { sequence: 'asc' } } },
          });

          return {
            order: finalOrder as Order & { lines: OrderLine[] },
            firedLineIds: eligibleLines.map((l) => l.id),
          };
        },
      );
    } catch (error) {
      if (isRoutingFailure(error)) {
        throw new UnprocessableEntityException((error as Error).message);
      }
      throw error;
    }
  }
}

function isRoutingFailure(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.startsWith('ROUTING_')
  );
}
