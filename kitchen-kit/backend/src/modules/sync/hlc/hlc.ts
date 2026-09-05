/**
 * Hybrid Logical Clock — `FR-OFF-041` [M].
 *
 * The SRS states the algorithm normatively, in full (§21.7). It is reproduced
 * here VERBATIM and is implemented exactly as written:
 *
 *   On local event:
 *     l' = max(l, physical_time)
 *     c' = (l' == l) ? c + 1 : 0
 *
 *   On receiving message with (l_msg, c_msg):
 *     l' = max(l, l_msg, physical_time)
 *     c' = if l' == l == l_msg then max(c, c_msg) + 1
 *          else if l' == l      then c + 1
 *          else if l' == l_msg then c_msg + 1
 *          else 0
 *
 * This is a SHARED algorithm under `FR-OFF-050`: the Dart client must produce
 * byte-identical results on the same inputs (`CT-06`). It therefore lives in a
 * dependency-free module, is driven by a language-neutral corpus
 * (`kitchen-kit/conformance/hlc/`), and MUST NOT be "improved" on one side.
 * An optimisation here is a divergence there.
 *
 * ── CANONICAL REPRESENTATION (ratified 2026-09-02, GD-D1-02) ────────────────
 *
 *   <physical_ms>.<logical>.<node>
 *
 *   physical_ms  exactly 13 zero-padded decimal digits, Unix epoch MILLISECONDS
 *   logical      exactly 5 zero-padded decimal digits
 *   node         exactly 32 lowercase hex characters — the originating
 *                terminal's UUID with the dashes removed
 *
 * Fixed width is the whole point: because every field is zero-padded to a
 * constant length, LEXICOGRAPHIC string order IS the correct total HLC order.
 * PostgreSQL can index and range over the stored string with no parsing, and
 * `ORDER BY hlc` is the causal order.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
 * `GD-D1-03` (bounded server adoption / per-terminal server clock) is
 * **DEFERRED, not ratified**. Nothing here bounds, clamps, or refuses a
 * received physical component: the algorithm is applied as specified, and a
 * skewed device is DETECTED and RECORDED (`FR-OFF-042`, `device-state.service`)
 * rather than silently corrected. `CT-10` (device three hours ahead) passes on
 * the algorithm as written — ordering preserved, skew alerted, original
 * timestamps retained — which is exactly why no deviation is needed.
 *
 * A received HLC is NEVER rewritten. It is part of the operation's identity and
 * part of the audit record.
 */

/** Raised on any malformed or out-of-range HLC input. Always fail closed. */
export class HlcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlcError';
  }
}

export interface Hlc {
  /** `l` — Unix epoch milliseconds. */
  readonly physicalMs: number;
  /** `c` — the logical counter. */
  readonly logical: number;
  /** 32 lowercase hex characters. */
  readonly node: string;
}

/** 13 digits: 0 … 9_999_999_999_999 (year 2286). Safely inside 2^53. */
export const HLC_MAX_PHYSICAL_MS = 9_999_999_999_999;
/** 5 digits. */
export const HLC_MAX_LOGICAL = 99_999;

const HLC_PATTERN = /^(\d{13})\.(\d{5})\.([0-9a-f]{32})$/;
const NODE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Derive the `node` segment from a terminal UUID.
 *
 * The node exists solely to make comparison a TOTAL order: two devices that
 * produce a byte-identical `physical.logical` still resolve deterministically,
 * and both sides compute the same winner without coordinating. It is not part
 * of the `FR-OFF-041` algorithm.
 */
export function hlcNodeFromTerminalId(terminalId: string): string {
  const node = terminalId.replace(/-/g, '').toLowerCase();
  if (!NODE_PATTERN.test(node)) {
    throw new HlcError(
      `Cannot derive an HLC node from '${terminalId}': expected a UUID whose ` +
        'hex digits render as exactly 32 lowercase hex characters.',
    );
  }
  return node;
}

function assertComponents(
  physicalMs: number,
  logical: number,
  node: string,
): void {
  if (
    !Number.isInteger(physicalMs) ||
    physicalMs < 0 ||
    physicalMs > HLC_MAX_PHYSICAL_MS
  ) {
    throw new HlcError(
      `HLC physical component must be an integer in [0, ${HLC_MAX_PHYSICAL_MS}]; got ${physicalMs}.`,
    );
  }
  if (!Number.isInteger(logical) || logical < 0 || logical > HLC_MAX_LOGICAL) {
    // Overflow is a real bound, not a theoretical one: the 5-digit field is
    // part of the ratified wire format, so a counter beyond it cannot be
    // represented and must never be silently truncated.
    throw new HlcError(
      `HLC logical component must be an integer in [0, ${HLC_MAX_LOGICAL}]; got ${logical}.`,
    );
  }
  if (!NODE_PATTERN.test(node)) {
    throw new HlcError('HLC node must be exactly 32 lowercase hex characters.');
  }
}

/** Build a validated HLC. */
export function hlc(physicalMs: number, logical: number, node: string): Hlc {
  assertComponents(physicalMs, logical, node);
  return Object.freeze({ physicalMs, logical, node });
}

/** Render the canonical fixed-width representation. */
export function encodeHlc(value: Hlc): string {
  assertComponents(value.physicalMs, value.logical, value.node);
  return (
    `${String(value.physicalMs).padStart(13, '0')}.` +
    `${String(value.logical).padStart(5, '0')}.` +
    value.node
  );
}

/**
 * Parse the canonical representation. STRICT: anything that is not exactly
 * 13 digits, a dot, 5 digits, a dot and 32 lowercase hex characters is
 * rejected. No trimming, no case folding, no shorter/longer fields, no
 * alternate separators — a malformed HLC fails closed rather than being
 * coerced into a plausible one.
 */
export function parseHlc(raw: string): Hlc {
  const match = HLC_PATTERN.exec(raw);
  if (!match) {
    throw new HlcError(
      `Malformed HLC '${raw}': expected <13 digits>.<5 digits>.<32 lowercase hex>.`,
    );
  }
  return hlc(Number(match[1]), Number(match[2]), match[3]);
}

/** `true` when `raw` is a well-formed canonical HLC. */
export function isValidHlc(raw: string): boolean {
  return HLC_PATTERN.test(raw);
}

/**
 * Total order: physical, then logical, then node lexicographically.
 * Returns <0, 0 or >0 (Array#sort convention).
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs)
    return a.physicalMs < b.physicalMs ? -1 : 1;
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
  if (a.node === b.node) return 0;
  return a.node < b.node ? -1 : 1;
}

/**
 * `FR-OFF-041` local event, verbatim:
 *   l' = max(l, physical_time)
 *   c' = (l' == l) ? c + 1 : 0
 */
export function hlcLocalEvent(state: Hlc, physicalMs: number): Hlc {
  if (
    !Number.isInteger(physicalMs) ||
    physicalMs < 0 ||
    physicalMs > HLC_MAX_PHYSICAL_MS
  ) {
    throw new HlcError(
      `physical_time must be an integer in [0, ${HLC_MAX_PHYSICAL_MS}]; got ${physicalMs}.`,
    );
  }
  const l = state.physicalMs;
  const c = state.logical;
  const lPrime = Math.max(l, physicalMs);
  const cPrime = lPrime === l ? c + 1 : 0;
  return hlc(lPrime, cPrime, state.node);
}

/**
 * `FR-OFF-041` receive event, verbatim:
 *   l' = max(l, l_msg, physical_time)
 *   c' = if l' == l == l_msg then max(c, c_msg) + 1
 *        else if l' == l      then c + 1
 *        else if l' == l_msg then c_msg + 1
 *        else 0
 *
 * The receiver keeps its OWN node — the node identifies the clock, not the
 * message.
 */
export function hlcReceiveEvent(
  state: Hlc,
  message: Hlc,
  physicalMs: number,
): Hlc {
  if (
    !Number.isInteger(physicalMs) ||
    physicalMs < 0 ||
    physicalMs > HLC_MAX_PHYSICAL_MS
  ) {
    throw new HlcError(
      `physical_time must be an integer in [0, ${HLC_MAX_PHYSICAL_MS}]; got ${physicalMs}.`,
    );
  }
  const l = state.physicalMs;
  const c = state.logical;
  const lMsg = message.physicalMs;
  const cMsg = message.logical;

  const lPrime = Math.max(l, lMsg, physicalMs);
  let cPrime: number;
  if (lPrime === l && lPrime === lMsg) {
    cPrime = Math.max(c, cMsg) + 1;
  } else if (lPrime === l) {
    cPrime = c + 1;
  } else if (lPrime === lMsg) {
    cPrime = cMsg + 1;
  } else {
    cPrime = 0;
  }
  return hlc(lPrime, cPrime, state.node);
}
