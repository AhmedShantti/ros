import { Prisma } from '../../../generated/prisma/client';
import { OpenShiftCommand, OpenedShift } from './types';

/**
 * Workforce PUBLIC contract — the commands this module accepts.
 *
 * SRS §5.4 makes `contract/` the only importable directory of a module and
 * §5.2.3 enforces that mechanically ("A module MUST NOT import from another
 * module's internal directory"). Treasury needs exactly ONE thing from
 * Workforce — carried item P1D-A's `Workforce ──▶ Treasury [shift → cash
 * session]` relationship — so exactly one command is published. `ShiftsService`,
 * the Shift row and every future Workforce concern stay private.
 *
 * ── WHY A DIRECT CALL AND NOT AN EVENT ──────────────────────────────────────
 * SRS §5.5.1: a synchronous interface call is the pattern "when the caller
 * requires the result to proceed and the operation must be in the same
 * transaction". A CashSession names its Shift by FK, so it cannot be written
 * before the Shift exists, and §16.2's model only holds if the two commit
 * together. `shift.opened` (§5.5.4) is a NOTIFICATION of that fact and is a
 * separate obligation; it is unpublished because no event bus or outbox exists,
 * and it is reported as a gap rather than faked.
 *
 * The command takes the CALLER's transaction handle. That is a deliberate
 * narrowing, not a leak: it is the Prisma transaction type, not a Workforce
 * type, and it is what lets the two writes share one atomic unit.
 */
export const SHIFT_OPENER = Symbol('SHIFT_OPENER');

export interface ShiftOpener {
  /**
   * Open an Operational Shift, or return the existing one when the same ULID is
   * presented with identical content.
   *
   * @throws ConflictException when the id exists with DIFFERENT content — a
   *         permanent identity is never silently repointed (FR-OFF-015).
   */
  openShift(
    tx: Prisma.TransactionClient,
    command: OpenShiftCommand,
  ): Promise<OpenedShift>;
}
