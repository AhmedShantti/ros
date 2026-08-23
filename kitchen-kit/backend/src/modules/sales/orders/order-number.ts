/**
 * Human-readable order numbers — FR-POS-002 and FR-OFF-016.
 *
 * FR-POS-002, verbatim on the parts that matter:
 *
 *   "Order number format: `<branch_code>-<business_day_seq>` where the sequence
 *    is drawn from a locally-held block. Each terminal is issued a block of
 *    numbers on sync (default 500) and requests a new block when 80% consumed.
 *    Offline terminals that exhaust their block fall back to
 *    `<terminal_code>-<local_seq>` and are reconciled on sync."
 *
 * Pure logic. Everything a caller needs to allocate, format and validate a
 * number lives here; persistence and concurrency live in the service.
 *
 * WHY BLOCKS, AND WHAT IS FORBIDDEN. The number must be generated "locally
 * without requiring server connectivity". That rules out, and this module
 * deliberately never performs:
 *   - `SELECT MAX(order_number) + 1` — needs the server and races;
 *   - a global PostgreSQL sequence — needs the server;
 *   - an in-process counter — not durable, not offline-safe, not unique
 *     across terminals.
 * A terminal holds a reserved RANGE, so it can keep numbering while offline and
 * still never collide with another terminal.
 */

/** FR-POS-002: "a block of numbers on sync (default 500)". */
export const DEFAULT_BLOCK_SIZE = 500;

/** FR-POS-002: "requests a new block when 80% consumed". */
export const REFILL_THRESHOLD = 0.8;

export class OrderNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderNumberError';
  }
}

export interface NumberBlock {
  readonly blockStart: number;
  readonly blockEnd: number;
  /** Next sequence to hand out; `blockEnd + 1` means exhausted. */
  readonly nextSeq: number;
}

/** Inclusive count of numbers in the block. */
export function blockSize(block: NumberBlock): number {
  return block.blockEnd - block.blockStart + 1;
}

export function remaining(block: NumberBlock): number {
  return Math.max(0, block.blockEnd - block.nextSeq + 1);
}

export function isExhausted(block: NumberBlock): boolean {
  return block.nextSeq > block.blockEnd;
}

/** FR-POS-002's 80% rule — should the terminal ask for another block yet? */
export function needsRefill(block: NumberBlock): boolean {
  const consumed = blockSize(block) - remaining(block);
  return consumed >= blockSize(block) * REFILL_THRESHOLD;
}

/**
 * Where the next block starts, given the highest `block_end` already issued for
 * this (branch, business day).
 *
 * Blocks are contiguous and never overlap: the next one begins immediately after
 * the last. Passing `null` means no block has been issued today, so numbering
 * starts at 1.
 */
export function nextBlockStart(highestIssuedEnd: number | null): number {
  return highestIssuedEnd === null ? 1 : highestIssuedEnd + 1;
}

export function makeBlock(
  start: number,
  size = DEFAULT_BLOCK_SIZE,
): NumberBlock {
  if (!Number.isInteger(size) || size < 1) {
    throw new OrderNumberError(
      `Block size must be a positive integer, got ${size}.`,
    );
  }
  if (!Number.isInteger(start) || start < 1) {
    throw new OrderNumberError(
      `Block start must be a positive integer, got ${start}.`,
    );
  }
  return { blockStart: start, blockEnd: start + size - 1, nextSeq: start };
}

/** Take the next sequence, returning it and the advanced block. */
export function takeNext(block: NumberBlock): {
  seq: number;
  block: NumberBlock;
} {
  if (isExhausted(block)) {
    throw new OrderNumberError(
      'This number block is exhausted. Issue a new block, or fall back to the ' +
        'terminal-local form defined by FR-POS-002.',
    );
  }
  return {
    seq: block.nextSeq,
    block: { ...block, nextSeq: block.nextSeq + 1 },
  };
}

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

/** `<branch_code>-<business_day_seq>` — the normal, block-drawn form. */
export function formatOrderNumber(branchCode: string, seq: number): string {
  if (!CODE_PATTERN.test(branchCode)) {
    throw new OrderNumberError(
      `Invalid branch code: ${JSON.stringify(branchCode)}.`,
    );
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new OrderNumberError(
      `Order sequence must be a positive integer, got ${seq}.`,
    );
  }
  const value = `${branchCode.toUpperCase()}-${seq}`;
  assertFitsColumn(value);
  return value;
}

/**
 * `<terminal_code>-<local_seq>` — FR-POS-002's offline fallback for a terminal
 * that has exhausted its block and cannot reach the server.
 *
 * Reconciliation on sync belongs to the Offline/Sync slice; this function only
 * produces the documented shape so an offline client is not forced to invent one.
 */
export function formatFallbackOrderNumber(
  terminalCode: string,
  localSeq: number,
): string {
  if (!CODE_PATTERN.test(terminalCode)) {
    throw new OrderNumberError(
      `Invalid terminal code: ${JSON.stringify(terminalCode)}.`,
    );
  }
  if (!Number.isInteger(localSeq) || localSeq < 1) {
    throw new OrderNumberError(
      `Local sequence must be a positive integer, got ${localSeq}.`,
    );
  }
  const value = `${terminalCode.toUpperCase()}-${localSeq}`;
  assertFitsColumn(value);
  return value;
}

/** `orders.order_number` is VARCHAR(24). */
function assertFitsColumn(value: string): void {
  if (value.length > 24) {
    throw new OrderNumberError(
      `Order number "${value}" exceeds the 24-character column limit.`,
    );
  }
}

const ORDER_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,15}-\d{1,10}$/;

/** Shape check for a client-supplied (offline-generated) order number. */
export function isValidOrderNumber(value: string): boolean {
  return value.length <= 24 && ORDER_NUMBER_PATTERN.test(value);
}
