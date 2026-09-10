/**
 * ServiceChargePolicy rule-set — the typed shape `sales.service_charge_
 * policies.rules` (JSONB) is validated against, and the parser that
 * enforces it (P2D, ratified P2D-R1 clause 3).
 *
 * ONE atomic array per policy VERSION — see `ServiceChargePolicy`'s own
 * schema docblock for why this is a single JSONB column, never a child
 * table. This file owns ONLY the shape/validation; matching a specific
 * `Order`'s `orderType`/`guestCount` against a resolved rule-set (which
 * rule WINS when more than one could match) is explicitly P2E — not
 * decided, not guessed, not implemented here.
 */

import { OrderType } from '../../../generated/prisma/client';
import {
  ExactDecimal,
  parseExactDecimal,
} from '../../../common/money/rounding';

const ORDER_TYPE_VALUES: ReadonlySet<string> = new Set(
  Object.values(OrderType),
);

/**
 * One rule within a policy version's rule-set.
 *
 * - `orderType: null` — applies to every order type.
 * - `minGuestCount: null` — no guest-count condition; otherwise the rule
 *   applies when `Order.guestCount >= minGuestCount`.
 * - `ratePercent` — an exact-decimal STRING (never a JS number — ADR-008),
 *   non-negative. No upper bound is enforced: no SRS/governance/existing
 *   precedent (`country-pack.parser.ts`'s own `asRatePercent`) defines one,
 *   and none is invented here.
 */
export interface ServiceChargePolicyRule {
  readonly orderType: OrderType | null;
  readonly minGuestCount: number | null;
  readonly ratePercent: string;
}

/** Raised when a rule-set fails structural/semantic validation. */
export class ServiceChargePolicyRuleValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ServiceChargePolicyRuleValidationError';
  }
}

function fail(path: string, message: string): never {
  throw new ServiceChargePolicyRuleValidationError(path, message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object.');
  }
  return value as Record<string, unknown>;
}

function parseOrderType(value: unknown, path: string): OrderType | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ORDER_TYPE_VALUES.has(value)) {
    fail(
      path,
      `expected null or one of ${[...ORDER_TYPE_VALUES].join(', ')}, got ${JSON.stringify(value)}.`,
    );
  }
  return value as OrderType;
}

function parseMinGuestCount(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(path, 'expected null or a non-negative integer.');
  }
  return value;
}

/**
 * `parseExactDecimal` is the SAME ADR-008 exact-decimal discipline
 * `country-pack.parser.ts`'s own `asRatePercent` uses: a JSON number is
 * IEEE-754 and must never seed a monetary/percentage computation, so a
 * rate is a STRING in plain decimal notation, never exponent notation,
 * never negative. No upper bound is invented (see interface docblock).
 */
function parseRatePercent(value: unknown, path: string): string {
  if (typeof value === 'number') {
    fail(
      path,
      'a rate must be an exact decimal STRING (e.g. "12.5"); a JSON number is ' +
        'binary floating point and cannot represent every rate exactly.',
    );
  }
  if (typeof value !== 'string') {
    fail(path, 'expected an exact-decimal string.');
  }
  const trimmed = value.trim();
  let parsed: ExactDecimal;
  try {
    parsed = parseExactDecimal(trimmed);
  } catch (error) {
    fail(path, (error as Error).message);
  }
  if (parsed.unscaled < 0n) fail(path, 'a rate may not be negative.');
  return trimmed;
}

function parseRule(raw: unknown, path: string): ServiceChargePolicyRule {
  const obj = asObject(raw, path);
  return {
    orderType: parseOrderType(obj.orderType, `${path}.orderType`),
    minGuestCount: parseMinGuestCount(
      obj.minGuestCount,
      `${path}.minGuestCount`,
    ),
    ratePercent: parseRatePercent(obj.ratePercent, `${path}.ratePercent`),
  };
}

/**
 * Parse and validate a complete rule-set.
 *
 * `[]` is VALID and preserved exactly — "explicitly no service charge at
 * this configured level" (P2D-R1 clause 3), never coerced into "no rules
 * supplied" or rejected as empty. There is no partial/best-effort result:
 * a rule-set either validates whole or not at all.
 *
 * @throws ServiceChargePolicyRuleValidationError on any malformed rule.
 */
export function parseServiceChargePolicyRules(
  raw: unknown,
): readonly ServiceChargePolicyRule[] {
  if (!Array.isArray(raw)) {
    fail('rules', 'expected an array.');
  }
  return raw.map((rule, i) => parseRule(rule, `rules[${i}]`));
}
