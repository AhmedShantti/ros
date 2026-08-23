/**
 * Tax computation contracts — SRS §16.6 (FR-FIN-030…035) and §16.7 (BR-FIN-001,
 * BR-FIN-002).
 *
 * These are DOMAIN types, not HTTP DTOs: a `Money`, a resolved tax class and a
 * pricing mode. Nothing here knows what a request looks like, and nothing here
 * knows what jurisdiction it is serving — CR-03 and FR-FIN-030 both require tax
 * to come from the country pack's engine rather than from compiled logic, so the
 * only country-specific things in this file are the values the caller passes in.
 */

import { Money } from '../../../common/money/money';
import { PricingMode, TaxClassDef } from '../country-pack/country-pack.model';

/** Raised when a line cannot be taxed with the data supplied. */
export class TaxComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxComputationError';
  }
}

/** Raised when a tax class code is not defined by the resolved pack. */
export class UnknownTaxClassError extends TaxComputationError {
  constructor(
    readonly classCode: string,
    packLabel: string,
  ) {
    super(
      `Tax class ${JSON.stringify(classCode)} is not defined by country pack ${packLabel}.`,
    );
    this.name = 'UnknownTaxClassError';
  }
}

/**
 * One line's tax input.
 *
 * `taxableBase` is the line's own amount — FR-FIN-034 forbids deriving tax from
 * an order total, so the engine is never handed one. Under `tax_exclusive` the
 * base is the line NET; under `tax_inclusive` it is the line GROSS. That is the
 * whole difference between the two modes as far as arithmetic is concerned.
 */
export interface TaxLineInput {
  readonly taxableBase: Money;
  /** Already resolved, including any order-type override. */
  readonly taxClass: TaxClassDef;
  readonly pricingMode: PricingMode;
}

/** One component's contribution — FR-FIN-032's per-component breakdown. */
export interface TaxComponentAmount {
  readonly code: string;
  /** The exact percent applied, rendered for receipts/fiscal payloads. */
  readonly ratePercent: string;
  readonly amount: Money;
}

/**
 * A line's tax result.
 *
 * `exempt` and `zeroRated` are carried separately and are never merged.
 * FR-FIN-033 lists zero-rated and exempt as distinct classes, and a fiscal
 * authority treats them differently: a zero-rated supply is inside the scope of
 * the tax at 0%, an exempt supply is outside it. Both amount to zero money; only
 * one of them belongs in a tax breakdown.
 */
export interface LineTaxResult {
  readonly taxClassCode: string;
  readonly pricingMode: PricingMode;
  /** Line amount excluding tax. */
  readonly netAmount: Money;
  /** Sum of the component amounts. */
  readonly taxAmount: Money;
  /** `netAmount + taxAmount`. Equals the input base under inclusive pricing. */
  readonly grossAmount: Money;
  readonly exempt: boolean;
  readonly zeroRated: boolean;
  /** Empty for an exempt class; one entry per component otherwise. */
  readonly components: readonly TaxComponentAmount[];
}

/**
 * FR-LOC-025 — a registered tax-engine strategy.
 *
 * A strategy understands a tax MODEL. Rates, classes and rounding stay in pack
 * data, so adding a jurisdiction or changing a rate never reaches this
 * interface; only a genuinely novel tax model does.
 */
export interface TaxComputationStrategy {
  readonly id: string;
  computeLine(input: TaxLineInput): LineTaxResult;
}
