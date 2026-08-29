/**
 * PAY_IN / PAY_OUT / SAFE_DROP — FR-POS-091 [M].
 *
 * Authority: `docs/reports/claude/2026-08-28_P1G0_cash-movements-design-gate.md`
 * (CONTROLLING), corrected by the 2026-08-28 implementation-correction prompt
 * ("CORRECTION 1 — client id is required", "CORRECTION 2 — one actual insert
 * only").
 *
 * ── PERMANENT-ID PROTOCOL (CORRECTION 2) ────────────────────────────────────
 * Exactly ONE `cash_movements` row and ONE `CASH_MOVEMENT_RECORDED` audit
 * entry may exist for a successful business id, under real concurrency:
 *
 *   1. Permanent-id replay/conflict check is LOGICALLY FIRST — before any
 *      CashSession-dependent mutation. Existing + identical -> replay
 *      (zero new effect). Existing + differing -> 409.
 *   2. Otherwise: lock the CashSession (transaction-scoped ADVISORY lock —
 *      see below), validate open/branch/employee/currency.
 *   3. Exactly ONE actual `INSERT ... ON CONFLICT ("id") DO NOTHING
 *      RETURNING ...` (P1E-5A pattern — never insert-then-catch-P2002, which
 *      leaves the transaction ABORTED for every subsequent statement).
 *   4. If that INSERT returns zero rows (another transaction won the SAME
 *      permanent-id race between step 1 and step 3), `SELECT` the winning
 *      row IN THE STILL-HEALTHY TRANSACTION: identical facts -> replay with
 *      NO duplicate audit; differing facts -> 409.
 *
 * ── CONCURRENCY-SAFE SESSION VALIDATION ─────────────────────────────────────
 * The design gate specified `SELECT ... FOR UPDATE` on `cash_sessions` for
 * this lock. Implementation finding: Postgres requires the **UPDATE**
 * privilege (not merely SELECT) to take a row lock via `FOR UPDATE` —
 * `ros_app` deliberately holds no UPDATE grant on `cash_sessions`
 * (append-only-until-P1G-1 posture), so that literal mechanism is
 * inoperable without widening the grant. Used instead: a
 * transaction-scoped **advisory lock**
 * (`pg_advisory_xact_lock(hashtext('ros_cash_session'), hashtext(cashSessionId))`),
 * giving the IDENTICAL serialization guarantee (blocks a concurrent writer;
 * auto-released at COMMIT/ROLLBACK) with no grant change — and matching this
 * repository's own existing precedent (`AuditService.record`'s per-tenant
 * chain lock uses the same primitive). A movement can never be recorded
 * against a session a concurrent close (a future P1G-1) is in the middle of
 * closing PROVIDED P1G-1 acquires the SAME advisory lock before mutating —
 * a documented contract for that future slice. Two concurrent movements on
 * the same session serialize rather than racing a read-then-write window.
 * P1G-0 touches ONLY `cash_sessions` — no `Order`, no `Inventory` — so it
 * cannot invert the existing P1F-2 `CashSession -> Order -> Inventory` lock
 * order (design gate §10).
 *
 * ── OWN-SESSION ONLY ─────────────────────────────────────────────────────
 * §15.2 supplies `cash.session.close_other` for close but NO `_other`
 * variant for any movement — cross-session authorization is NOT
 * SOURCE-DEFINED and is not invented (design gate §4). The actor's Employee
 * MUST equal the session's owning Employee.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UUID_PATTERN } from '../../../common/ids';
import {
  CashMovement,
  CashMovementType,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';

export interface RecordCashMovementInput {
  /** FR-OFF-015 — the device's permanent ULID for this movement. REQUIRED. */
  readonly id: string;
  readonly cashSessionId: string;
  /** Positive integer minor units, as an exact string. */
  readonly amountMinor: string;
  readonly reason: string;
  readonly occurredAt?: Date;
  /** Trusted employee from the POS session. NEVER from the request body. */
  readonly employeeId: string;
  /** Trusted terminal from the POS session. NEVER from the request body. */
  readonly terminalId: string;
}

export interface RecordCashMovementResult {
  readonly movement: CashMovement;
  readonly created: boolean;
}

interface LockedSession {
  readonly id: string;
  readonly branchId: string;
  readonly employeeId: string;
  readonly currency: string;
  readonly status: 'open' | 'closed';
}

@Injectable()
export class CashMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  payIn(tenantId: string, actorUserId: string, input: RecordCashMovementInput) {
    return this.record(tenantId, actorUserId, 'pay_in', input);
  }

  payOut(
    tenantId: string,
    actorUserId: string,
    input: RecordCashMovementInput,
  ) {
    return this.record(tenantId, actorUserId, 'pay_out', input);
  }

  safeDrop(
    tenantId: string,
    actorUserId: string,
    input: RecordCashMovementInput,
  ) {
    return this.record(tenantId, actorUserId, 'safe_drop', input);
  }

  // ------------------------------------------------------------- internals

  private async record(
    tenantId: string,
    actorUserId: string,
    movementType: CashMovementType,
    input: RecordCashMovementInput,
  ): Promise<RecordCashMovementResult> {
    if (!UUID_PATTERN.test(input.id)) {
      throw new BadRequestException('id must be a ULID rendered as a UUID.');
    }
    if (!UUID_PATTERN.test(input.cashSessionId)) {
      throw new BadRequestException(
        'cashSessionId must be a ULID rendered as a UUID.',
      );
    }
    const amount = this.parseAmount(input.amountMinor);
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason must not be blank.');
    }
    const occurredAt = input.occurredAt ?? new Date();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // ── STEP 1 — permanent-id replay/conflict check, LOGICALLY FIRST. ──
        // Before ANY CashSession-dependent mutation: no lock taken yet.
        const existing = await tx.cashMovement.findUnique({
          where: { id: input.id },
        });
        if (existing) {
          this.assertIdentical(existing, {
            tenantId,
            cashSessionId: input.cashSessionId,
            employeeId: input.employeeId,
            movementType,
            amount,
            reason,
          });
          return { movement: existing, created: false };
        }

        // ── STEP 2 — lock the CashSession, validate. ────────────────────
        // `SELECT ... FOR UPDATE` requires the UPDATE privilege in Postgres
        // (not merely SELECT) — `ros_app` deliberately holds no UPDATE grant
        // on `cash_sessions` (append-only-until-P1G-1 posture). A
        // transaction-scoped ADVISORY lock gives the identical
        // serialization guarantee (blocks a concurrent writer, auto-released
        // at COMMIT/ROLLBACK) without requiring any grant change, and
        // matches this repository's own precedent
        // (`AuditService.record`'s per-tenant chain lock). Every writer of
        // `cash_movements` — and, per the design gate §10, any future P1G-1
        // close — MUST acquire this SAME lock before touching the session.
        await tx.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
          'ros_cash_session',
          input.cashSessionId,
        );

        const rows = await tx.$queryRaw<LockedSession[]>`
          SELECT "id",
                 "branch_id" AS "branchId",
                 "employee_id" AS "employeeId",
                 "currency",
                 "status"
          FROM "treasury"."cash_sessions"
          WHERE "tenant_id" = ${tenantId}::uuid AND "id" = ${input.cashSessionId}::uuid
        `;
        const session = rows[0];
        if (!session) {
          throw new NotFoundException('Cash session not found.');
        }
        if (session.status !== 'open') {
          throw new ConflictException('That cash session is not open.');
        }

        const terminal = await tx.terminal.findUnique({
          where: { id: input.terminalId },
          select: { branchId: true },
        });
        if (!terminal) {
          throw new NotFoundException('Terminal not found.');
        }
        if (terminal.branchId !== session.branchId) {
          throw new ForbiddenException(
            'That cash session belongs to a different branch than this terminal.',
          );
        }
        // Own-session only — no `_other` permission exists for any movement
        // (design gate §4).
        if (session.employeeId !== input.employeeId) {
          throw new ForbiddenException(
            'That cash session does not belong to the employee recording this movement.',
          );
        }

        // ── STEP 3 — exactly ONE actual INSERT, concurrency-safe. ───────
        const inserted = await tx.$queryRaw<CashMovement[]>`
          INSERT INTO "treasury"."cash_movements" (
            "id", "tenant_id", "branch_id", "cash_session_id", "employee_id",
            "movement_type", "amount", "currency", "reason", "occurred_at",
            "performed_by"
          ) VALUES (
            ${input.id}::uuid, ${tenantId}::uuid, ${session.branchId}::uuid,
            ${input.cashSessionId}::uuid, ${input.employeeId}::uuid,
            ${movementType}::"treasury"."CashMovementType", ${amount}, ${session.currency},
            ${reason}, ${occurredAt}::timestamptz, ${actorUserId}::uuid
          )
          ON CONFLICT ("id") DO NOTHING
          RETURNING
            "id", "tenant_id" AS "tenantId", "branch_id" AS "branchId",
            "cash_session_id" AS "cashSessionId", "employee_id" AS "employeeId",
            "movement_type" AS "movementType", "amount", "currency", "reason",
            "occurred_at" AS "occurredAt", "created_at" AS "createdAt",
            "performed_by" AS "performedBy"
        `;

        if (inserted.length === 0) {
          // ── STEP 4 — lost a same-permanent-id race between step 1 and
          // step 3. SELECT the winner in the STILL-HEALTHY transaction (the
          // raw INSERT resolved its own conflict internally — no exception
          // was raised, so the transaction was never aborted).
          const winner = await tx.cashMovement.findUnique({
            where: { id: input.id },
          });
          if (!winner) {
            throw new Error(
              `Cash movement insert conflicted for id ${input.id} but no row is visible afterwards.`,
            );
          }
          this.assertIdentical(winner, {
            tenantId,
            cashSessionId: input.cashSessionId,
            employeeId: input.employeeId,
            movementType,
            amount,
            reason,
          });
          // NO duplicate audit — this transaction did not create the row.
          return { movement: winner, created: false };
        }

        const movement = inserted[0];

        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_MOVEMENT_RECORDED,
          entityType: AUDIT_ENTITY.CASH_MOVEMENT,
          actorType: 'user',
          actorId: actorUserId,
          entityId: movement.id,
          terminalId: input.terminalId,
          metadata: {
            movementType: movement.movementType,
            cashSessionId: movement.cashSessionId,
            branchId: movement.branchId,
            employeeId: movement.employeeId,
            amountMinor: movement.amount.toString(),
            currency: movement.currency,
            reason: movement.reason,
            occurredAt: movement.occurredAt.toISOString(),
          },
        });

        return { movement, created: true };
      },
    );
  }

  /**
   * A duplicate business id is permanent-identity conflict territory
   * (FR-OFF-015): same id, same content -> the caller is retrying; same id,
   * different content -> a conflict, never a silent rewrite.
   *
   * `occurredAt` is deliberately EXCLUDED from this comparison — mirroring
   * `OrderPayment`'s own precedent of excluding its server-timing field
   * (`processedAt`) from the identical-content check. When the caller omits
   * `occurredAt`, this service defaults it to `new Date()` PER CALL, so two
   * genuinely-identical retries of the same business id (a sequential HTTP
   * retry, or two requests racing on the same id) would otherwise disagree
   * on a value neither one actually asserted as a business fact.
   */
  private assertIdentical(
    existing: CashMovement,
    expected: {
      tenantId: string;
      cashSessionId: string;
      employeeId: string;
      movementType: CashMovementType;
      amount: bigint;
      reason: string;
    },
  ): void {
    const identical =
      existing.tenantId === expected.tenantId &&
      existing.cashSessionId === expected.cashSessionId &&
      existing.employeeId === expected.employeeId &&
      existing.movementType === expected.movementType &&
      existing.amount === expected.amount &&
      existing.reason === expected.reason;
    if (!identical) {
      throw new ConflictException(
        'That cash movement id already exists with different content. A ' +
          'client-generated identifier is permanent (FR-OFF-015).',
      );
    }
  }

  /**
   * Positive integer minor units. A client can never submit a negative or
   * zero amount — the movement TYPE decides the sign (design gate §2).
   */
  private parseAmount(raw: string): bigint {
    if (!/^(?!0+$)\d{1,18}$/.test(raw)) {
      throw new BadRequestException(
        'amountMinor must be a positive (non-zero) whole number of minor ' +
          'units expressed as a string, e.g. "5000" for 50.00.',
      );
    }
    return BigInt(raw);
  }
}
