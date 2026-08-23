/**
 * Operational Shift — one employee's duty period at one branch.
 *
 * Authorised by carried item P1D-A, which reopens D-2's Workforce defer NARROWLY
 * for exactly this and nothing else. There is no schedule here, no attendance,
 * no clock event, no break, no leave and no payroll: this slice must not become
 * the Workforce module.
 *
 * ── WHY A SHIFT AT ALL, RATHER THAN JUST A CASH SESSION ────────────────────
 * The SRS keeps them apart in four places — §5.4's aggregate list, the context
 * map's `Workforce ──▶ Treasury [shift → cash session]`, §5.5.4's `shift.opened`
 * publisher, and §16.2's "one employee, one SHIFT, one drawer". Collapsing them
 * would mean a cashier's duty period could not outlive one drawer, and every
 * later Workforce concern (attendance, labour cost, tip pooling) would have
 * nothing to attach to.
 *
 * ── WHAT IS DELIBERATELY NOT ENFORCED ──────────────────────────────────────
 * There is no one-open-shift-per-employee rule. The only overlap statement in
 * the SRS is §7.3 #26's "no overlapping shifts for one employee", and that is an
 * invariant of the SCHEDULE aggregate over SCHEDULED shifts — roster planning,
 * not this. Inventing a global uniqueness for tidiness would be a product
 * decision no source makes, and CashSession integrity does not need it: a
 * session names its exact shift through a four-column key.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { OpenShiftCommand, OpenedShift, ShiftOpener } from '../contract';

@Injectable()
export class ShiftsService implements ShiftOpener {
  /**
   * Open a shift, or return the existing one when the same ULID arrives with
   * identical content.
   *
   * The reuse path is what makes a retry safe at the DOMAIN level, independently
   * of the HTTP idempotency store: the client's ULID is a permanent identity
   * (FR-OFF-015), so presenting it twice must mean the same shift, not a second
   * one and not a rewritten one.
   */
  async openShift(
    tx: Prisma.TransactionClient,
    command: OpenShiftCommand,
  ): Promise<OpenedShift> {
    const existing = await tx.shift.findUnique({
      where: { id: command.id },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        employeeId: true,
        status: true,
        openedAt: true,
      },
    });

    if (existing) {
      // A permanent identity is never silently repointed. Same id, different
      // content is a caller error, not an update.
      if (
        existing.tenantId !== command.tenantId ||
        existing.branchId !== command.branchId ||
        existing.employeeId !== command.employeeId
      ) {
        throw new ConflictException(
          'That shift id already exists with different content. A client-generated ' +
            'identifier is permanent (FR-OFF-015) and is never reassigned.',
        );
      }
      if (existing.status !== 'open') {
        throw new ConflictException('That shift is already closed.');
      }
      return { ...existing, created: false };
    }

    const shift = await tx.shift.create({
      data: {
        id: command.id,
        tenantId: command.tenantId,
        branchId: command.branchId,
        employeeId: command.employeeId,
        status: 'open',
        openedAt: command.openedAt,
      },
      select: {
        id: true,
        tenantId: true,
        branchId: true,
        employeeId: true,
        status: true,
        openedAt: true,
      },
    });
    return { ...shift, created: true };
  }
}
