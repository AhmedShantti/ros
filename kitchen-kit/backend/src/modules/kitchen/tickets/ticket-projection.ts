import {
  TicketLineStatus,
  TicketStatus,
} from '../../../generated/prisma/client';

/**
 * Ticket aggregate projection — design gate §11/§16, maintained
 * transactionally from line facts (not derived on read).
 *
 *   in_progress ⇐ at least one line has ever been explicitly started
 *                  (startedAt IS NOT NULL — a durable historical fact, not
 *                  the line's CURRENT status, since a line that skipped
 *                  straight from queued to bumped/ready never carries the
 *                  `started` status value at all), and not every
 *                  non-cancelled line is ready-or-beyond yet
 *   ready       ⇐ every NON-CANCELLED line is ready-or-beyond
 *   bumped      ⇐ every NON-CANCELLED line is bumped-or-beyond
 *
 * An all-cancelled ticket (no non-cancelled lines) must NOT become `ready`
 * or `bumped` — it falls through to `in_progress`/`queued` by the same
 * `startedAt` rule.
 *
 * Pure function: no database, no clock (the caller supplies `now` only when
 * actually writing a timestamp — this module never reads one).
 */
export interface TicketLineProjectionFact {
  readonly status: TicketLineStatus;
  readonly startedAt: Date | null;
}

const READY_OR_BEYOND: ReadonlySet<TicketLineStatus> = new Set([
  'ready',
  'bumped',
  'served',
]);
const BUMPED_OR_BEYOND: ReadonlySet<TicketLineStatus> = new Set([
  'bumped',
  'served',
]);

export function projectTicketStatus(
  lines: readonly TicketLineProjectionFact[],
): TicketStatus {
  const nonCancelled = lines.filter((l) => l.status !== 'cancelled');

  if (
    nonCancelled.length > 0 &&
    nonCancelled.every((l) => BUMPED_OR_BEYOND.has(l.status))
  ) {
    return 'bumped';
  }
  if (
    nonCancelled.length > 0 &&
    nonCancelled.every((l) => READY_OR_BEYOND.has(l.status))
  ) {
    return 'ready';
  }
  if (lines.some((l) => l.startedAt !== null)) {
    return 'in_progress';
  }
  return 'queued';
}

/** FR-KDS-024 bump-item/bump-all eligible source states. */
export const BUMP_ELIGIBLE_STATUSES: ReadonlySet<TicketLineStatus> = new Set([
  'queued',
  'started',
  'ready',
]);

/** A replay of an already-final action — success, no-op, no timestamp overwrite. */
export function isLineAlreadyBumped(status: TicketLineStatus): boolean {
  return BUMPED_OR_BEYOND.has(status);
}
