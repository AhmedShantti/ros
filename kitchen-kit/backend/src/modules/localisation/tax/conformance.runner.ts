/**
 * Shared tax conformance corpus runner — FR-OFF-050 [M].
 *
 * "Business logic that must produce identical results on client and server SHALL
 * be specified as a language-neutral test corpus, executed by both the Dart
 * client test suite and the TypeScript server test suite in CI." Tax computation
 * and rounding are named explicitly in the corpus scope.
 *
 * The corpus lives OUTSIDE this package — `kitchen-kit/conformance/tax/` — so it
 * belongs to neither runtime. This file is the TypeScript half of FR-OFF-050;
 * the Dart half does not exist yet, and neither does the CI job that would run
 * both, so FR-OFF-050 and FR-OFF-051 are PARTIAL rather than met.
 *
 * ── CORPUS ENCODING RULES ──────────────────────────────────────────────────
 * Every monetary amount, quantity and rate is a decimal STRING. A JSON number
 * would be IEEE-754 and could not carry an amount above 2^53 or an exactly
 * representable rate, which would make the corpus itself the source of a
 * divergence it exists to detect. Only structural integers — a currency's
 * `exponent`, a `roundingPrecision`, a cash-rounding step — appear as numbers.
 *
 * The runner is deliberately STRICT: a malformed case throws rather than being
 * skipped, because a corpus case that silently does not run is worse than no
 * case at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Money } from '../../../common/money/money';
import { parseCountryPack } from '../country-pack/country-pack.parser';
import { TaxEngineRegistry } from './tax-engine.registry';
import {
  computeLineTax,
  computeTaxableBase,
  sumLineTax,
} from './tax.calculator';

/** Raised when a corpus file or case is not well formed. */
export class ConformanceCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceCorpusError';
  }
}

export interface ConformanceLineInput {
  readonly unitPrice: string;
  readonly quantity: string;
  readonly taxClass: string;
  readonly orderType: string | null;
  readonly modifierTotal?: string;
  readonly lineDiscount?: string;
}

export interface ConformanceComponentExpectation {
  readonly code: string;
  readonly ratePercent: string;
  readonly amount: string;
}

export interface ConformanceLineExpectation {
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
  readonly exempt: boolean;
  readonly zeroRated: boolean;
  readonly components: readonly ConformanceComponentExpectation[];
}

export interface ConformanceCase {
  readonly id: string;
  readonly description: string;
  readonly pack: unknown;
  readonly lines: readonly ConformanceLineInput[];
  readonly expected: {
    readonly lines: readonly ConformanceLineExpectation[];
    readonly taxTotal: string;
  };
}

export interface ConformanceCorpus {
  readonly corpusVersion: string;
  readonly cases: readonly ConformanceCase[];
}

// ---------------------------------------------------------------- validation

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new ConformanceCorpusError(`Corpus case is missing ${what}.`);
  }
  return value;
}

function mustBeAmountString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new ConformanceCorpusError(
      `${what} must be a whole number of minor units expressed as a string, got ` +
        `${JSON.stringify(value)}.`,
    );
  }
  return value;
}

function assertCase(value: unknown, where: string): ConformanceCase {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConformanceCorpusError(`${where}: a case must be an object.`);
  }
  const c = value as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new ConformanceCorpusError(`${where}: a case needs a non-empty id.`);
  }
  if (typeof c.description !== 'string') {
    throw new ConformanceCorpusError(`${c.id}: a case needs a description.`);
  }
  must(c.pack, `a pack document (case ${c.id})`);
  if (!Array.isArray(c.lines) || c.lines.length === 0) {
    throw new ConformanceCorpusError(
      `${c.id}: a case needs at least one line.`,
    );
  }
  const expected = must(c.expected, `expectations (case ${c.id})`) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(expected.lines)) {
    throw new ConformanceCorpusError(
      `${c.id}: expected.lines must be an array.`,
    );
  }
  if (expected.lines.length !== c.lines.length) {
    throw new ConformanceCorpusError(
      `${c.id}: ${c.lines.length} input lines but ${expected.lines.length} expectations.`,
    );
  }
  mustBeAmountString(expected.taxTotal, `${c.id}: expected.taxTotal`);
  return c as unknown as ConformanceCase;
}

export function parseCorpus(raw: unknown, where: string): ConformanceCorpus {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConformanceCorpusError(`${where}: a corpus must be an object.`);
  }
  const corpus = raw as Record<string, unknown>;
  if (typeof corpus.corpusVersion !== 'string') {
    throw new ConformanceCorpusError(
      `${where}: corpusVersion must be a string so the file carries no JSON numbers.`,
    );
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new ConformanceCorpusError(
      `${where}: a corpus needs at least one case.`,
    );
  }
  const ids = new Set<string>();
  const cases = corpus.cases.map((c) => {
    const parsed = assertCase(c, where);
    if (ids.has(parsed.id)) {
      throw new ConformanceCorpusError(
        `${where}: duplicate case id ${parsed.id}.`,
      );
    }
    ids.add(parsed.id);
    return parsed;
  });
  return { corpusVersion: corpus.corpusVersion, cases };
}

// ------------------------------------------------------------------ loading

/** The corpus directory, shared with (future) Dart consumers. */
export const TAX_CORPUS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'tax',
);

export interface LoadedCorpus {
  readonly file: string;
  readonly raw: unknown;
  readonly corpus: ConformanceCorpus;
}

export function loadTaxCorpus(dir: string = TAX_CORPUS_DIR): LoadedCorpus[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.corpus.json'))
    .sort();
  if (files.length === 0) {
    throw new ConformanceCorpusError(`No corpus file found in ${dir}.`);
  }
  return files.map((file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return { file, raw, corpus: parseCorpus(raw, file) };
  });
}

// ---------------------------------------------------------------- execution

export interface ConformanceComponentActual {
  readonly code: string;
  readonly ratePercent: string;
  readonly amount: string;
}

export interface ConformanceLineActual {
  readonly net: string;
  readonly tax: string;
  readonly gross: string;
  readonly exempt: boolean;
  readonly zeroRated: boolean;
  readonly components: readonly ConformanceComponentActual[];
}

export interface ConformanceActual {
  readonly lines: readonly ConformanceLineActual[];
  readonly taxTotal: string;
}

const engines = new TaxEngineRegistry();

/**
 * Execute one case through the production tax path.
 *
 * The pack goes through the real parser and the lines through the real
 * calculator — no test-only arithmetic anywhere — so a divergence the corpus
 * detects is a divergence in shipping code.
 */
export function runConformanceCase(
  testCase: ConformanceCase,
): ConformanceActual {
  const pack = parseCountryPack(testCase.pack, { knownEngines: engines.ids });
  const currency = pack.currency.currency;

  const results = testCase.lines.map((line, i) => {
    const where = `${testCase.id} line ${i}`;
    const taxableBase = computeTaxableBase({
      unitPrice: Money.of(
        BigInt(mustBeAmountString(line.unitPrice, `${where}.unitPrice`)),
        currency,
      ),
      quantity: must(line.quantity, `${where}.quantity`),
      ...(line.modifierTotal === undefined
        ? {}
        : {
            modifierTotal: Money.of(
              BigInt(
                mustBeAmountString(
                  line.modifierTotal,
                  `${where}.modifierTotal`,
                ),
              ),
              currency,
            ),
          }),
      ...(line.lineDiscount === undefined
        ? {}
        : {
            lineDiscount: Money.of(
              BigInt(
                mustBeAmountString(line.lineDiscount, `${where}.lineDiscount`),
              ),
              currency,
            ),
          }),
      rounding: pack.tax.roundingMode,
    });

    return computeLineTax(pack, engines, {
      taxableBase,
      taxClassCode: must(line.taxClass, `${where}.taxClass`),
      orderType: line.orderType ?? null,
    });
  });

  return {
    lines: results.map((r) => ({
      net: r.netAmount.amount.toString(),
      tax: r.taxAmount.amount.toString(),
      gross: r.grossAmount.amount.toString(),
      exempt: r.exempt,
      zeroRated: r.zeroRated,
      components: r.components.map((c) => ({
        code: c.code,
        ratePercent: c.ratePercent,
        amount: c.amount.amount.toString(),
      })),
    })),
    taxTotal: sumLineTax(results, currency).amount.toString(),
  };
}
