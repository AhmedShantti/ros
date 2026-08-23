/**
 * Country Pack parser / validator — the gate a pack document must pass before it
 * can be selected for any sale.
 *
 * FR-LOC-023 requires conformance validation before activation; this is the
 * structural half of it (the arithmetic half is the shared corpus, and the
 * invoice/QR half does not exist yet, which is why FR-LOC-023 is not claimed).
 * ADR-005's consequence note is explicit that "a malformed pack could produce
 * incorrect tax on live sales", so every rule here rejects rather than coerces.
 *
 * ── WHY RATES ARE STRINGS ───────────────────────────────────────────────────
 * A JSON number is IEEE-754. `14.0` survives, but a pack author who writes
 * `0.0725` or a three-decimal fee rate would silently seed a binary-inexact
 * factor into a monetary computation, which ADR-008 forbids outright. Rates are
 * therefore exact decimal STRINGS parsed by the existing `parseExactDecimal`,
 * and a JSON number in a rate position is a validation error, not a conversion.
 * The SRS renders its sample in YAML (`rate: 14.0`); the JSON encoding of that
 * same value in this repository is `"14.0"`.
 */

import { Currency, currencyWithExponent } from '../../../common/money/currency';
import {
  ExactDecimal,
  RoundingMode,
  parseExactDecimal,
} from '../../../common/money/rounding';
import {
  COUNTRY_PACK_VERSION_MAX_LENGTH,
  ComputationLevel,
  CountryPack,
  CountryPackValidationError,
  CurrencyConfig,
  OrderTypeTaxOverrideDef,
  PricingMode,
  TaxClassDef,
  TaxComponentDef,
  TaxConfig,
} from './country-pack.model';

const CODE_PATTERN = /^[A-Z]{2,8}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

const PRICING_MODES: ReadonlySet<string> = new Set([
  'tax_inclusive',
  'tax_exclusive',
]);
const COMPUTATION_LEVELS: ReadonlySet<string> = new Set(['line']);
const ROUNDING_MODES: ReadonlySet<string> = new Set(
  Object.values(RoundingMode),
);
/** See `TaxComponentBase` — the deliberate refusal to guess compounding. */
const COMPONENT_BASES: ReadonlySet<string> = new Set(['line_net']);

export interface ParseCountryPackOptions {
  /**
   * FR-LOC-025 — the ids of the REGISTERED strategy implementations. A pack
   * naming an engine outside this set is rejected, which is what stops a pack
   * from causing an arbitrary strategy name to be instantiated.
   */
  readonly knownEngines: ReadonlySet<string>;
}

// --------------------------------------------------------------- primitives

function fail(path: string, message: string): never {
  throw new CountryPackValidationError(path, message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected an object.');
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array.');
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string.');
  return value;
}

function asBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'expected a boolean.');
  return value;
}

function asInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(path, 'expected an integer.');
  }
  return value;
}

/**
 * Parse an exact decimal rate. Rejects JSON numbers, exponent notation and
 * anything else `parseExactDecimal` refuses.
 */
function asRatePercent(value: unknown, path: string): ExactDecimal {
  if (typeof value === 'number') {
    fail(
      path,
      'a rate must be an exact decimal STRING (e.g. "14.0"); a JSON number is ' +
        'binary floating point and cannot represent every rate exactly.',
    );
  }
  const text = asString(value, path);
  let parsed: ExactDecimal;
  try {
    parsed = parseExactDecimal(text);
  } catch (error) {
    fail(path, (error as Error).message);
  }
  if (parsed.unscaled < 0n) fail(path, 'a rate may not be negative.');
  return parsed;
}

/** Strict calendar date. `2026-02-30` is rejected, not rolled forward. */
function asEffectiveFrom(value: unknown, path: string): Date {
  const text = asString(value, path);
  if (!DATE_PATTERN.test(text)) {
    fail(
      path,
      `expected an ISO date (YYYY-MM-DD), got ${JSON.stringify(text)}.`,
    );
  }
  const [y, m, d] = text.split('-').map((p) => Number.parseInt(p, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    fail(path, `${JSON.stringify(text)} is not a real calendar date.`);
  }
  return date;
}

// ---------------------------------------------------------------- currency

function parseCurrency(raw: unknown, path: string): CurrencyConfig {
  const obj = asObject(raw, path);
  const code = asString(obj.code, `${path}.code`);
  const exponent = asInteger(obj.exponent, `${path}.exponent`);

  let currency: Currency;
  try {
    currency = currencyWithExponent(code, exponent);
  } catch (error) {
    fail(path, (error as Error).message);
  }

  const symbolPosition = obj.symbolPosition;
  if (
    symbolPosition !== undefined &&
    symbolPosition !== 'prefix' &&
    symbolPosition !== 'suffix'
  ) {
    fail(`${path}.symbolPosition`, 'expected "prefix" or "suffix".');
  }

  const cashRaw =
    obj.cashRounding === undefined
      ? {}
      : asObject(obj.cashRounding, `${path}.cashRounding`);
  const enabled = asBoolean(
    cashRaw.enabled,
    `${path}.cashRounding.enabled`,
    false,
  );
  let stepMinorUnits: bigint | undefined;
  if (enabled) {
    // BR-FIN-004 names "the nearest 5 or 25 minor units" but leaves the step to
    // the jurisdiction, so it is pack data and must be present once enabled.
    const step = asInteger(
      cashRaw.stepMinorUnits,
      `${path}.cashRounding.stepMinorUnits`,
    );
    if (step <= 0)
      fail(`${path}.cashRounding.stepMinorUnits`, 'must be positive.');
    stepMinorUnits = BigInt(step);
  }

  return {
    currency,
    ...(typeof obj.symbol === 'string' ? { symbol: obj.symbol } : {}),
    ...(symbolPosition ? { symbolPosition } : {}),
    cashRounding: {
      enabled,
      ...(stepMinorUnits === undefined ? {} : { stepMinorUnits }),
    },
  };
}

// --------------------------------------------------------------------- tax

interface RateDefaults {
  readonly roundingMode: RoundingMode;
  readonly roundingPrecision: number;
  readonly exponent: number;
}

function parseRoundingMode(value: unknown, path: string): RoundingMode {
  const text = asString(value, path);
  if (!ROUNDING_MODES.has(text)) {
    fail(
      path,
      `unsupported rounding mode ${JSON.stringify(text)}. Supported: ` +
        `${[...ROUNDING_MODES].join(', ')}.`,
    );
  }
  return text as RoundingMode;
}

function parseRoundingPrecision(
  value: unknown,
  path: string,
  exponent: number,
): number {
  const precision = asInteger(value, path);
  if (precision < 0) fail(path, 'must not be negative.');
  if (precision > exponent) {
    // Rounding to MORE decimal places than the currency has minor units is not
    // representable: an amount is an integer count of minor units, so there is
    // no finer place to round to. Rounding to FEWER is meaningful (round tax to
    // the nearest 10 minor units) and is supported.
    fail(
      path,
      `precision ${precision} exceeds the currency's minor-unit exponent ${exponent}; ` +
        'a monetary amount has no finer place to round to.',
    );
  }
  return precision;
}

function parseLabel(raw: unknown, path: string): Record<string, string> {
  const obj = asObject(raw, path);
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(obj)) {
    out[lang] = asString(text, `${path}.${lang}`);
  }
  return out;
}

function parseComponent(
  raw: unknown,
  path: string,
  defaults: RateDefaults,
): TaxComponentDef {
  const obj = asObject(raw, path);
  const code = asString(obj.code, `${path}.code`);
  if (!IDENTIFIER_PATTERN.test(code)) {
    fail(`${path}.code`, 'expected a lower_snake_case identifier.');
  }

  const base =
    obj.base === undefined ? 'line_net' : asString(obj.base, `${path}.base`);
  if (!COMPONENT_BASES.has(base)) {
    fail(
      `${path}.base`,
      `unsupported base ${JSON.stringify(base)}. Only "line_net" is implemented: ` +
        'FR-FIN-032 mandates per-component bases but no source defines whether a ' +
        'component compounds on another, so any other base is refused rather than guessed.',
    );
  }

  const roundingMode =
    obj.roundingMode === undefined
      ? defaults.roundingMode
      : parseRoundingMode(obj.roundingMode, `${path}.roundingMode`);
  const roundingPrecision =
    obj.roundingPrecision === undefined
      ? defaults.roundingPrecision
      : parseRoundingPrecision(
          obj.roundingPrecision,
          `${path}.roundingPrecision`,
          defaults.exponent,
        );

  return {
    code,
    ratePercent: asRatePercent(obj.rate, `${path}.rate`),
    base: 'line_net',
    roundingMode,
    roundingPrecision,
    ...(obj.label !== undefined
      ? { label: parseLabel(obj.label, `${path}.label`) }
      : {}),
  };
}

/**
 * Parse the `{ rate }` / `{ components }` pair shared by a class and by an
 * order-type override.
 *
 * `rate: null` is the SRS's exempt marker and is the ONLY way to produce an
 * exempt entry — an empty component list is a malformed definition, not a
 * synonym for exempt, because it would erase the zero-rated/exempt distinction
 * FR-FIN-033 requires.
 */
interface RateOrComponents {
  readonly exempt: boolean;
  readonly components: TaxComponentDef[];
}

function parseRateOrComponents(
  obj: Record<string, unknown>,
  path: string,
  defaults: RateDefaults,
  fallbackComponentCode: string,
): RateOrComponents {
  // `Object.hasOwn`, not `in`: an inherited `rate` must not read as declared.
  const hasRate = Object.hasOwn(obj, 'rate');
  const hasComponents = Object.hasOwn(obj, 'components');

  if (hasRate && hasComponents) {
    fail(path, 'declare either "rate" or "components", never both.');
  }
  if (!hasRate && !hasComponents) {
    fail(path, 'must declare "rate" (possibly null) or "components".');
  }

  if (hasRate) {
    if (obj.rate === null) return { exempt: true, components: [] };
    return {
      exempt: false,
      components: [
        {
          code: fallbackComponentCode,
          ratePercent: asRatePercent(obj.rate, `${path}.rate`),
          base: 'line_net',
          roundingMode: defaults.roundingMode,
          roundingPrecision: defaults.roundingPrecision,
        },
      ],
    };
  }

  const rawComponents = asArray(obj.components, `${path}.components`);
  if (rawComponents.length === 0) {
    fail(
      `${path}.components`,
      'must not be empty. An exempt entry is expressed as "rate": null, so an ' +
        'empty component list would collapse the zero-rated / exempt distinction ' +
        'FR-FIN-033 requires.',
    );
  }
  const seen = new Set<string>();
  const components = rawComponents.map((c, i) => {
    const component = parseComponent(c, `${path}.components[${i}]`, defaults);
    if (seen.has(component.code)) {
      fail(
        `${path}.components[${i}].code`,
        `duplicate component ${JSON.stringify(component.code)}.`,
      );
    }
    seen.add(component.code);
    return component;
  });
  return { exempt: false, components };
}

function parseTax(
  raw: unknown,
  path: string,
  exponent: number,
  options: ParseCountryPackOptions,
): TaxConfig {
  const obj = asObject(raw, path);

  const engine = asString(obj.engine, `${path}.engine`);
  if (!options.knownEngines.has(engine)) {
    fail(
      `${path}.engine`,
      `unknown tax engine ${JSON.stringify(engine)}. FR-LOC-025 requires the ` +
        'engine to be one of the registered strategy implementations: ' +
        `${[...options.knownEngines].sort().join(', ') || '(none registered)'}.`,
    );
  }

  const pricingMode = asString(obj.pricingMode, `${path}.pricingMode`);
  if (!PRICING_MODES.has(pricingMode)) {
    fail(
      `${path}.pricingMode`,
      `expected one of ${[...PRICING_MODES].join(', ')}.`,
    );
  }

  const computationLevel = asString(
    obj.computationLevel,
    `${path}.computationLevel`,
  );
  if (!COMPUTATION_LEVELS.has(computationLevel)) {
    fail(
      `${path}.computationLevel`,
      `FR-FIN-034 requires line-level computation; ${JSON.stringify(computationLevel)} is not supported.`,
    );
  }

  const roundingMode = parseRoundingMode(
    obj.roundingMode,
    `${path}.roundingMode`,
  );
  const roundingPrecision = parseRoundingPrecision(
    obj.roundingPrecision,
    `${path}.roundingPrecision`,
    exponent,
  );
  const defaults: RateDefaults = { roundingMode, roundingPrecision, exponent };

  const rawClasses = asArray(obj.classes, `${path}.classes`);
  if (rawClasses.length === 0) fail(`${path}.classes`, 'must not be empty.');

  const classes = new Map<string, TaxClassDef>();
  rawClasses.forEach((rawClass, i) => {
    const cPath = `${path}.classes[${i}]`;
    const c = asObject(rawClass, cPath);
    const code = asString(c.code, `${cPath}.code`);
    if (!IDENTIFIER_PATTERN.test(code)) {
      fail(`${cPath}.code`, 'expected a lower_snake_case identifier.');
    }
    if (classes.has(code)) {
      fail(`${cPath}.code`, `duplicate tax class ${JSON.stringify(code)}.`);
    }
    const { exempt, components } = parseRateOrComponents(
      c,
      cPath,
      defaults,
      code,
    );
    classes.set(code, {
      code,
      exempt,
      components,
      ...(c.label !== undefined
        ? { label: parseLabel(c.label, `${cPath}.label`) }
        : {}),
    });
  });

  const rawOverrides =
    obj.orderTypeOverrides === undefined
      ? []
      : asArray(obj.orderTypeOverrides, `${path}.orderTypeOverrides`);
  const overrideKeys = new Set<string>();
  const orderTypeOverrides: OrderTypeTaxOverrideDef[] = rawOverrides.map(
    (rawOverride, i) => {
      const oPath = `${path}.orderTypeOverrides[${i}]`;
      const o = asObject(rawOverride, oPath);
      const orderType = asString(o.orderType, `${oPath}.orderType`);
      if (!IDENTIFIER_PATTERN.test(orderType)) {
        fail(`${oPath}.orderType`, 'expected a lower_snake_case identifier.');
      }
      const classCode = asString(o.classCode, `${oPath}.classCode`);
      if (!classes.has(classCode)) {
        fail(
          `${oPath}.classCode`,
          `unknown tax class ${JSON.stringify(classCode)}.`,
        );
      }
      const key = `${orderType} ${classCode}`;
      if (overrideKeys.has(key)) {
        fail(oPath, `duplicate override for ${orderType}/${classCode}.`);
      }
      overrideKeys.add(key);
      const { exempt, components } = parseRateOrComponents(
        o,
        oPath,
        defaults,
        classCode,
      );
      return { orderType, classCode, exempt, components };
    },
  );

  return {
    engine,
    pricingMode: pricingMode as PricingMode,
    computationLevel: computationLevel as ComputationLevel,
    roundingMode,
    roundingPrecision,
    classes,
    serviceChargeTaxable: asBoolean(
      obj.serviceChargeTaxable,
      `${path}.serviceChargeTaxable`,
      false,
    ),
    orderTypeOverrides,
    ...(obj.registrationLabel !== undefined
      ? {
          registrationLabel: parseLabel(
            obj.registrationLabel,
            `${path}.registrationLabel`,
          ),
        }
      : {}),
    ...(typeof obj.registrationPattern === 'string'
      ? { registrationPattern: obj.registrationPattern }
      : {}),
  };
}

// ------------------------------------------------------------------ export

/**
 * Parse and validate a Country Pack document.
 *
 * @throws CountryPackValidationError on any malformed field. There is no
 *         partial or best-effort result: a pack either loads whole or not at all.
 */
export function parseCountryPack(
  raw: unknown,
  options: ParseCountryPackOptions,
): CountryPack {
  const doc = asObject(raw, 'countryPack');

  const code = asString(doc.code, 'countryPack.code');
  if (!CODE_PATTERN.test(code)) {
    fail('countryPack.code', 'expected 2-8 upper-case letters.');
  }

  const version = asString(doc.version, 'countryPack.version');
  if (!VERSION_PATTERN.test(version)) {
    fail(
      'countryPack.version',
      'expected an alphanumeric version, e.g. "2026.1".',
    );
  }
  if (version.length > COUNTRY_PACK_VERSION_MAX_LENGTH) {
    // `sales.orders.country_pack_version` is VARCHAR(24); a version that cannot
    // be pinned onto an order must fail at load, not at the first sale.
    fail(
      'countryPack.version',
      `must be at most ${COUNTRY_PACK_VERSION_MAX_LENGTH} characters so it can be ` +
        'pinned onto every order priced by this pack (FR-LOC-021).',
    );
  }

  const effectiveFrom = asEffectiveFrom(
    doc.effectiveFrom,
    'countryPack.effectiveFrom',
  );
  const currency = parseCurrency(doc.currency, 'countryPack.currency');
  const tax = parseTax(
    doc.tax,
    'countryPack.tax',
    currency.currency.exponent,
    options,
  );

  return { code, version, effectiveFrom, currency, tax };
}
