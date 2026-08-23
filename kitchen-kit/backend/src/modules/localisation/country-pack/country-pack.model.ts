/**
 * Country Pack — the runtime domain model (SRS §22.2, ADR-005, CR-03).
 *
 * A Country Pack is a SIGNED, VERSIONED configuration bundle holding everything
 * jurisdiction-specific. CR-03 forbids compiling country-specific tax logic into
 * core code and ADR-005 makes country rules DATA plus a small registered set of
 * strategy implementations, so nothing in this file — or anywhere under
 * `localisation/` — may branch on a country code. The code is a *key*, never a
 * condition.
 *
 * ── WHAT THE SOURCES DECIDE, AND WHAT THEY DO NOT ───────────────────────────
 *
 * SRS §22.2 gives the pack's shape verbatim: `code`, `version`, `effectiveFrom`,
 * `signature`, a `currency` block and a `tax` block carrying `engine`,
 * `pricingMode`, `computationLevel`, `roundingMode`, `roundingPrecision`,
 * `classes` (`{ code, rate, label }`, with `rate: null` for exempt),
 * `serviceChargeTaxable` and `orderTypeOverrides`. Everything modelled here maps
 * onto one of those, or onto the approved SQL's `fiscal.tax_rules`
 * (`applies_to_order_type` — the order-type override's physical form).
 *
 * Two things the sources do NOT decide are marked at their definition:
 *
 *   1. The multi-component grammar. FR-FIN-032 [M] mandates several
 *      simultaneous components "each with its own rate, base, and rounding", but
 *      neither the SRS sample nor the approved SQL gives a storage form or any
 *      compounding rule. Only the one unambiguous base — each component on the
 *      line's net — is accepted; every other base value is REJECTED rather than
 *      guessed. See {@link TaxComponentBase}.
 *   2. The signature's concrete cryptography. FR-LOC-022 states the security
 *      property and the approved SQL gives `fiscal.country_packs.signature
 *      BYTEA`; no source picks an algorithm, canonical byte form, key format or
 *      trust store. See `country-pack.signature.ts`.
 *
 * Sections of §22.2 outside this slice (invoice, fiscal, labour, calendar,
 * legal) are deliberately absent: modelling them without their subsystems would
 * be decoration. A pack document MAY carry them; they are ignored, not rejected.
 */

import { Currency } from '../../../common/money/currency';
import { ExactDecimal, RoundingMode } from '../../../common/money/rounding';

/** Raised when a pack document cannot be parsed into a valid pack. */
export class CountryPackValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CountryPackValidationError';
  }
}

/** FR-FIN-031 — the two pricing modes the System must support. */
export type PricingMode = 'tax_inclusive' | 'tax_exclusive';

/**
 * FR-FIN-034 [M] — "Tax SHALL be computed at line level and summed, not computed
 * on the order total", and the rationale calls it "not negotiable". `line` is
 * therefore the only level this engine accepts; a pack asking for anything else
 * is rejected rather than silently downgraded.
 */
export type ComputationLevel = 'line';

/**
 * The base a tax component applies to.
 *
 * `line_net` is the ONLY value accepted, and that is a deliberate refusal.
 * FR-FIN-032 requires per-component bases but no source says whether a second
 * component compounds on the first, whether a fee enters VAT's base, or whether
 * a service charge is inside or outside it. Inventing an answer would put
 * fabricated money on live invoices, so the parser rejects any other base and
 * the gap is reported instead.
 */
export type TaxComponentBase = 'line_net';

/**
 * One tax component — FR-FIN-032's "own rate, base, and rounding".
 *
 * A class declared with a bare `rate` becomes exactly one component whose code
 * is the class code. That mapping is mechanical and jurisdiction-free: naming
 * the implicit component "vat" would smuggle a jurisdiction's vocabulary into
 * core code, which is precisely what CR-03 forbids.
 */
export interface TaxComponentDef {
  /** Stable identifier used on the breakdown, e.g. `standard`, `municipality`. */
  readonly code: string;
  /** Rate as an exact PERCENT (14 means 14%). Never a JavaScript number. */
  readonly ratePercent: ExactDecimal;
  readonly base: TaxComponentBase;
  /** BR-FIN-002 default, overridable per component by the pack. */
  readonly roundingMode: RoundingMode;
  /** Decimal places the component's amount is rounded to; ≤ currency exponent. */
  readonly roundingPrecision: number;
  readonly label?: Readonly<Record<string, string>>;
}

/**
 * A tax class — FR-FIN-033's `standard | reduced | zero-rated | exempt`.
 *
 * ZERO-RATED and EXEMPT are NOT collapsed. The SRS sample distinguishes them by
 * data alone (`zero` carries `rate: 0.0`, `exempt` carries `rate: null`), so the
 * distinction is carried structurally: an exempt class has NO components and is
 * outside the scope of the tax, while a zero-rated class has a component that is
 * genuinely computed and genuinely yields zero. Both produce a zero amount; only
 * one of them appears in the tax breakdown.
 */
export interface TaxClassDef {
  readonly code: string;
  /** True when the pack gave `rate: null` — outside the scope of the tax. */
  readonly exempt: boolean;
  /** Empty if and only if `exempt`. */
  readonly components: readonly TaxComponentDef[];
  readonly label?: Readonly<Record<string, string>>;
}

/**
 * FR-FIN-033's "order-type-dependent rates where the jurisdiction differentiates
 * dine-in from takeaway", physically shaped by the approved SQL's
 * `fiscal.tax_rules.applies_to_order_type`.
 */
export interface OrderTypeTaxOverrideDef {
  readonly orderType: string;
  readonly classCode: string;
  readonly exempt: boolean;
  readonly components: readonly TaxComponentDef[];
}

export interface TaxConfig {
  /** FR-LOC-025 — must name one of the REGISTERED strategy implementations. */
  readonly engine: string;
  readonly pricingMode: PricingMode;
  readonly computationLevel: ComputationLevel;
  /** FR-FIN-035 / BR-FIN-002 — the pack's rounding mode. */
  readonly roundingMode: RoundingMode;
  /** FR-FIN-035 — the pack's rounding point, in decimal places. */
  readonly roundingPrecision: number;
  readonly classes: ReadonlyMap<string, TaxClassDef>;
  /** §22.2. Carried for the service-charge slice; unused until that exists. */
  readonly serviceChargeTaxable: boolean;
  readonly orderTypeOverrides: readonly OrderTypeTaxOverrideDef[];
  readonly registrationLabel?: Readonly<Record<string, string>>;
  readonly registrationPattern?: string;
}

/** §22.2 `currency` block. Cash rounding (BR-FIN-004) is carried, not applied. */
export interface CurrencyConfig {
  readonly currency: Currency;
  readonly symbol?: string;
  readonly symbolPosition?: 'prefix' | 'suffix';
  readonly cashRounding: {
    readonly enabled: boolean;
    readonly stepMinorUnits?: bigint;
  };
}

export interface CountryPack {
  /** Jurisdiction key, e.g. `EG`. A KEY — never a branch condition (CR-03). */
  readonly code: string;
  /** Pack version, e.g. `2026.1`. Pinned onto every order it prices. */
  readonly version: string;
  /** FR-LOC-021 — the instant from which this version may be used. */
  readonly effectiveFrom: Date;
  readonly currency: CurrencyConfig;
  readonly tax: TaxConfig;
}

/**
 * The value written to `sales.orders.country_pack_version` (VARCHAR(24)).
 *
 * The column stores the VERSION, and a version alone is only unique within a
 * jurisdiction — so the identifier is the version exactly as the pack declares
 * it, and the jurisdiction is recoverable from the order's branch. The parser
 * caps `version` at the column width so a pack that cannot be pinned is rejected
 * at load time rather than at the first sale.
 */
export const COUNTRY_PACK_VERSION_MAX_LENGTH = 24;

/** Human-readable pack identity for logs and errors. Never persisted. */
export function packLabel(pack: Pick<CountryPack, 'code' | 'version'>): string {
  return `${pack.code}-${pack.version}`;
}
