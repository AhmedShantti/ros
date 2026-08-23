/**
 * CashSession OPEN — FR-POS-090, FR-FIN-001, FR-FIN-002.
 *
 * "A cashier SHALL be required to open a shift, declaring an opening float,
 * before processing sales."
 *
 * ONE operational command produces BOTH the Operational Shift and the
 * CashSession, atomically. That is deliberate: FR-POS-090 describes a single
 * cashier action, and a cashier should not have to understand that "shift" lives
 * in Workforce and "session" lives in Treasury to start their day. The two
 * concepts stay separate in the model (carried item P1D-A); only the *command*
 * is unified.
 *
 * ── WHAT THE CLIENT MAY DECIDE, AND WHAT IT MAY NOT ────────────────────────
 * It supplies two permanent ULIDs (FR-OFF-015), a drawer, and the float it
 * counted. Everything else — tenant, branch, employee, terminal, currency,
 * status, opened-at — is derived from the trusted POS session. The DTO has no
 * field for any of them, so a caller cannot even express the attempt.
 *
 * ── WHERE EACH INVARIANT ACTUALLY LIVES ────────────────────────────────────
 * Almost none of them are enforced by the code below, and that is the point:
 *
 *   one open session per drawer   partial unique index (FR-FIN-001)
 *   exactly one employee          NOT NULL + the four-column shift FK (FR-FIN-002)
 *   session employee == shift's   four-column composite FK
 *   session branch == drawer's    three-column composite FK
 *   float >= 0                    CHECK constraint
 *   tenant isolation              RLS, ENABLE + FORCE
 *
 * The service turns the database's refusals into the right HTTP answers. It does
 * not duplicate them, because a check in application code that the database does
 * not also make is a check that a second code path can skip.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UUID_PATTERN } from '../../../common/ids';
import { Money } from '../../../common/money/money';
import { Prisma } from '../../../generated/prisma/client';
import type { CashSession } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { SHIFT_OPENER } from '../../workforce/contract';
import type { ShiftOpener } from '../../workforce/contract';
import { DrawersService } from '../drawers/drawers.service';

export interface OpenCashSessionInput {
  /** FR-OFF-015 — the device's ULID for the shift. Preserved exactly. */
  readonly shiftId: string;
  /** FR-OFF-015 — the device's ULID for the session. Preserved exactly. */
  readonly cashSessionId: string;
  readonly drawerId: string;
  /** Declared opening float, minor units, as an exact integer string. */
  readonly openingFloat: string;
  /** Trusted terminal from the POS session. NEVER from the request body. */
  readonly terminalId: string;
  /** Trusted employee from the POS session. NEVER from the request body. */
  readonly employeeId: string;
  /** Server clock. Exposed for deterministic tests, not for callers. */
  readonly at?: Date;
}

/** PostgreSQL unique-violation. The one-open-session index raises this. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly drawers: DrawersService,
    @Inject(SHIFT_OPENER) private readonly shifts: ShiftOpener,
  ) {}

  async open(
    tenantId: string,
    actorUserId: string,
    input: OpenCashSessionInput,
  ) {
    for (const [label, value] of [
      ['shiftId', input.shiftId],
      ['cashSessionId', input.cashSessionId],
      ['drawerId', input.drawerId],
    ] as const) {
      if (!UUID_PATTERN.test(value)) {
        throw new BadRequestException(
          `${label} must be a ULID rendered as a UUID.`,
        );
      }
    }
    if (input.shiftId === input.cashSessionId) {
      // Two distinct concepts (P1D-A) must not share one identity, or the audit
      // trail could not tell which record an id refers to.
      throw new BadRequestException(
        'The shift and cash session must have different identifiers.',
      );
    }
    const openingFloat = this.parseOpeningFloat(input.openingFloat);
    const at = input.at ?? new Date();

    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        // The terminal is the root of trust for the branch (FR-SEC-028).
        // Invisible cross-tenant under RLS -> 404, never 403.
        const terminal = await tx.terminal.findUnique({
          where: { id: input.terminalId },
          select: { id: true, branchId: true, status: true },
        });
        if (!terminal) throw new NotFoundException('Terminal not found.');
        if (terminal.status !== 'active') {
          throw new ConflictException('That terminal is not active.');
        }

        const branch = await tx.branch.findUnique({
          where: { id: terminal.branchId },
          select: { id: true, baseCurrency: true },
        });
        if (!branch) throw new NotFoundException('Branch not found.');

        const employee = await tx.employee.findUnique({
          where: { id: input.employeeId },
          select: {
            id: true,
            status: true,
            branches: { select: { branchId: true } },
          },
        });
        if (!employee) throw new NotFoundException('Employee not found.');
        if (employee.status !== 'active') {
          throw new ConflictException('That employee is not active.');
        }
        // FR-SEC-021's permitted-branch rule, the same one PIN authentication
        // and order capture already apply.
        if (!employee.branches.some((b) => b.branchId === branch.id)) {
          throw new ForbiddenException(
            'That employee is not permitted to work at this branch.',
          );
        }

        const drawer = await this.drawers.requireForBranch(
          tx,
          input.drawerId,
          branch.id,
          terminal.id,
        );

        // P1D-A: the Workforce concept, obtained through its public port. Same
        // transaction, so a shift can never exist without its session, or the
        // reverse.
        const shift = await this.shifts.openShift(tx, {
          id: input.shiftId,
          tenantId,
          branchId: branch.id,
          employeeId: employee.id,
          openedAt: at,
        });

        // The currency is the BRANCH's, snapshotted. A client cannot choose it,
        // and it is stored rather than re-derived so a later branch currency
        // change cannot reinterpret a historical float (ADR-008).
        const float = Money.of(openingFloat, branch.baseCurrency);

        // Whole row, not a projection: both branches below must return the same
        // shape, or the caller has to narrow a union for no reason.
        const existing = await tx.cashSession.findUnique({
          where: { id: input.cashSessionId },
        });
        if (existing) {
          // Same permanent identity, same content -> the caller is retrying.
          // Same identity, different content -> a conflict, never a rewrite.
          const identical =
            existing.tenantId === tenantId &&
            existing.branchId === branch.id &&
            existing.drawerId === drawer.id &&
            existing.shiftId === shift.id &&
            existing.employeeId === employee.id &&
            existing.openingFloat === float.amount &&
            existing.currency === branch.baseCurrency;
          if (!identical) {
            throw new ConflictException(
              'That cash session id already exists with different content. A ' +
                'client-generated identifier is permanent (FR-OFF-015).',
            );
          }
          return { session: existing, shift, drawer, created: false };
        }

        let session: CashSession;
        try {
          session = await tx.cashSession.create({
            data: {
              id: input.cashSessionId,
              tenantId,
              branchId: branch.id,
              drawerId: drawer.id,
              shiftId: shift.id,
              employeeId: employee.id,
              openingFloat: float.amount,
              currency: branch.baseCurrency,
              status: 'open',
              openedAt: at,
            },
          });
        } catch (error) {
          // FR-FIN-001, enforced by `uq_one_open_session_per_drawer`. Two racing
          // opens both reach the index; PostgreSQL admits one and rejects the
          // other, and the loser gets a deterministic business conflict rather
          // than a 500. There is no read-then-write window to lose.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === UNIQUE_VIOLATION
          ) {
            throw new ConflictException(
              'That drawer already has an open cash session. FR-FIN-001 permits ' +
                'only one at a time; close the existing session first.',
            );
          }
          throw error;
        }

        // Two state changes, two entries. Opening a shift and taking custody of a
        // drawer are separately accountable events even though one command
        // performs both — a later reader must be able to trace either alone.
        if (shift.created) {
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.SHIFT_OPENED,
            entityType: AUDIT_ENTITY.SHIFT,
            actorType: 'user',
            actorId: actorUserId,
            entityId: shift.id,
            terminalId: terminal.id,
            metadata: {
              branchId: branch.id,
              employeeId: employee.id,
              openedAt: shift.openedAt.toISOString(),
              cashSessionId: session.id,
            },
          });
        }
        await this.audit.record(tx, {
          tenantId,
          action: AUDIT_ACTION.CASH_SESSION_OPENED,
          entityType: AUDIT_ENTITY.CASH_SESSION,
          actorType: 'user',
          actorId: actorUserId,
          entityId: session.id,
          terminalId: terminal.id,
          metadata: {
            branchId: branch.id,
            drawerId: drawer.id,
            drawerName: drawer.name,
            shiftId: shift.id,
            employeeId: employee.id,
            // Exact minor units as a string: a JSON number would be IEEE-754.
            openingFloat: session.openingFloat.toString(),
            currency: session.currency,
            status: session.status,
            openedAt: session.openedAt.toISOString(),
          },
        });

        return { session, shift, drawer, created: true };
      },
    );
  }

  /**
   * Read one session — INTERNAL ONLY. No route calls this.
   *
   * The read is deliberately unexposed: §15.2 defines `cash.session.open` as
   * "Open a shift", a write authority, and supplies no CashSession read code;
   * its authoritative Appendix C is absent from the SRS, which is the same
   * situation ratified decision D-20 answered by DEFERRING the code rather than
   * inventing one. The query survives because the future Payment and Treasury
   * slices need it, and because that is where a read authority becomes
   * source-decidable. RLS still scopes it — a cross-tenant id returns null.
   */
  findOne(tenantId: string, id: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.cashSession.findUnique({ where: { id } }),
    );
  }

  /**
   * The open session on a drawer, if any. Exposed for the future Payment slice,
   * which must attribute cash to a session (carried item P1D-G).
   */
  findOpenForDrawer(tenantId: string, drawerId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.cashSession.findFirst({ where: { drawerId, status: 'open' } }),
    );
  }

  // ------------------------------------------------------------- internals

  /**
   * Parse the declared float.
   *
   * An exact integer STRING of minor units, never a JSON number: a float is
   * money, and ADR-008 keeps money out of IEEE-754 entirely. There is no
   * `parseFloat`, no `Number`, no `Math.round` on this path.
   *
   * Negative is refused. FR-POS-090 calls it a "float" — an amount placed in the
   * drawer to start — and no source describes a negative one. The database
   * refuses it too (`ck_cash_session_float`); this is the readable half.
   */
  private parseOpeningFloat(raw: string): bigint {
    if (!/^\d{1,18}$/.test(raw)) {
      throw new BadRequestException(
        'openingFloat must be a whole number of minor units expressed as a ' +
          'string, e.g. "50000" for 500.00. A negative or fractional float is ' +
          'not accepted.',
      );
    }
    return BigInt(raw);
  }
}
