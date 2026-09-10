/**
 * ServiceChargePolicy rule EVALUATION and MONEY computation — P2E
 * (`FR-PLT-028`/`FR-POS-055`). PURE, no I/O: everything the resolver or a
 * future Dart client will need is a function of its arguments
 * (ADR-004 / BR-FIN-005 / FR-OFF-050), exactly the discipline
 * `price-resolution.ts` and `tax.calculator.ts` already hold themselves to.
 *
 * This file owns exactly the two things `service-charge-policy-rules.ts`'s
 * own docblock named as explicitly NOT decided there: which rule wins when
 * more than one in a pinned version could match an order, and how the
 * winning rate turns into a minor-unit amount.
 *
 * ── RULE-MATCHING PRECEDENCE (the P2E semantic preflight's item A) ────────
 * P2D-R1's own "Not decided by this entry" section explicitly left this
 * open. No SRS text and no ratified governance decision states one either.
 * It is nonetheless determined here, not invented, from TWO existing,
 * already-shipped precedents in this exact domain:
 *
 *   1. `tax.calculator.ts`'s `resolveTaxClass` — an order-type-specific
 *      override REPLACES a base (order-type-agnostic) tax class WHOLE.
 *      A rule naming a specific `orderType` is, by the identical logic,
 *      more specific than a rule with `orderType: null` and wins over it.
 *   2. `minGuestCount` is a ONE-SIDED THRESHOLD, never a range
 *      (`maxGuestCount` is explicitly not invented — P2D-R1 clause 3).
 *      The only mathematically coherent reading of several co-configured
 *      thresholds for the same order type is a graduated structure: the
 *      HIGHEST threshold the order's `guestCount` still satisfies is the
 *      most specific applicable rule (a progressive-bracket reading — the
 *      same "narrowest qualifying band wins" shape `price-resolution.ts`
 *      already applies via its own tier system, generalised to a single
 *      numeric dimension instead of a discrete tier enum).
 *
 * Ranking is therefore: (1) an `orderType`-specific rule beats a wildcard
 * (`orderType: null`) rule; (2) among rules tied on that, the rule with the
 * NUMERICALLY HIGHEST satisfied `minGuestCount` wins (a rule with
 * `minGuestCount: null` ranks below every satisfied numeric threshold).
 *
 * A TRUE tie — two matching rules identical on both discriminators (a
 * genuine configuration duplicate, not a graduated structure) — is never
 * resolved by array order. It is reported as ambiguous, exactly
 * `price-resolution.ts`'s own "no winner is invented" philosophy for its
 * own genuinely tied candidates.
 */

import { Money } from '../../../common/money/money';
import {
  RoundingMode,
  divideRounded,
  pow10,
} from '../../../common/money/rounding';
import type { ServiceChargePolicyRule } from './service-charge-policy-rules';

/** What a rule is evaluated against — the two fields it can condition on. */
export interface ServiceChargeEvaluationInput {
  readonly orderType: string;
  /** `null` when the order records no guest count. */
  readonly guestCount: number | null;
}

/** Raised when two or more rules in the SAME rule-set tie on precedence. */
export class ServiceChargeRuleAmbiguityError extends Error {
  constructor(readonly rules: readonly ServiceChargePolicyRule[]) {
    super(
      'Two or more ServiceChargePolicy rules apply to this order with equal ' +
        'precedence (same orderType-specificity and the same minGuestCount ' +
        'threshold). This is a configuration defect, not a graduated ' +
        'structure — no winner is invented.',
    );
    this.name = 'ServiceChargeRuleAmbiguityError';
  }
}

function ruleMatches(
  rule: ServiceChargePolicyRule,
  input: ServiceChargeEvaluationInput,
): boolean {
  if (rule.orderType !== null && rule.orderType !== input.orderType) {
    return false;
  }
  if (rule.minGuestCount !== null) {
    // A null Order.guestCount never satisfies ANY explicit threshold,
    // including zero — "no guest-count condition" is represented
    // EXCLUSIVELY by `minGuestCount: null` (P2D-R1 clause 3's own
    // distinction between the two).
    if (input.guestCount === null) return false;
    if (input.guestCount < rule.minGuestCount) return false;
  }
  return true;
}

/** (orderType-specific, minGuestCount) — higher sorts first on both axes. */
function specificityKey(
  rule: ServiceChargePolicyRule,
): readonly [number, number] {
  return [rule.orderType !== null ? 1 : 0, rule.minGuestCount ?? -1];
}

function compareSpecificity(
  a: ServiceChargePolicyRule,
  b: ServiceChargePolicyRule,
): number {
  const [aType, aGuest] = specificityKey(a);
  const [bType, bGuest] = specificityKey(b);
  if (aType !== bType) return bType - aType;
  return bGuest - aGuest;
}

/**
 * The ONE rule that governs this order, or `null` for "no matching rule —
 * no service charge". Never mutates or re-validates `rules` — the caller's
 * pinned, already-parsed rule-set is trusted as-is.
 *
 * @throws ServiceChargeRuleAmbiguityError if two or more matching rules tie
 *   on precedence.
 */
export function evaluateServiceChargeRule(
  rules: readonly ServiceChargePolicyRule[],
  input: ServiceChargeEvaluationInput,
): ServiceChargePolicyRule | null {
  const matching = rules.filter((r) => ruleMatches(r, input));
  if (matching.length === 0) return null;

  const ranked = [...matching].sort(compareSpecificity);
  const winner = ranked[0];
  const tied = ranked.filter((r) => compareSpecificity(winner, r) === 0);
  if (tied.length > 1) {
    throw new ServiceChargeRuleAmbiguityError(tied);
  }
  return winner;
}

/**
 * The winning rule's rate applied to `base`, rounded EXACTLY ONCE
 * (BR-FIN-001) using the PINNED Country Pack's own rounding mode and
 * precision (FR-FIN-035) — never an independent hardcoded mode. Mirrors
 * `VatStandardStrategy.computeLine`'s single-component, exclusive-pricing
 * formula (`tax_i = round(net * n_i / D)`) exactly: service charge is not
 * tax and carries no inclusive/exclusive pricing-mode question of its own,
 * so only that one shape applies.
 */
export function computeServiceChargeAmount(
  base: Money,
  ratePercentUnscaled: bigint,
  ratePercentScale: number,
  roundingMode: RoundingMode,
  roundingPrecision: number,
): Money {
  const currency = base.currency;
  const denominator = 100n * pow10(ratePercentScale);
  const granularity = pow10(currency.exponent - roundingPrecision);
  const units = divideRounded(
    base.amount * ratePercentUnscaled,
    denominator * granularity,
    roundingMode,
  );
  return Money.of(units * granularity, currency);
}
