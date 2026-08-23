import {
  ConformanceCorpusError,
  TAX_CORPUS_DIR,
  loadTaxCorpus,
  parseCorpus,
  runConformanceCase,
} from './conformance.runner';

/**
 * FR-OFF-050 — the TypeScript half of the shared conformance suite.
 *
 * The Dart half and the CI job that would run both do not exist, so this proves
 * the SERVER matches the corpus. It does not yet prove client/server agreement,
 * and FR-OFF-050 / FR-OFF-051 / BR-FIN-005 stay PARTIAL until it does.
 */

const loaded = loadTaxCorpus();

describe('Shared tax conformance corpus (FR-OFF-050)', () => {
  it('finds corpus files outside the server package', () => {
    expect(TAX_CORPUS_DIR).toMatch(/kitchen-kit\/conformance\/tax$/);
    expect(loaded.length).toBeGreaterThan(0);
  });

  describe.each(loaded.map((l) => [l.file, l] as const))(
    '%s',
    (_file, entry) => {
      it.each(entry.corpus.cases.map((c) => [c.id, c] as const))(
        '%s',
        (_id, testCase) => {
          const actual = runConformanceCase(testCase);

          expect(actual.taxTotal).toBe(testCase.expected.taxTotal);
          expect(actual.lines).toHaveLength(testCase.expected.lines.length);
          testCase.expected.lines.forEach((expected, i) => {
            expect(actual.lines[i]).toEqual(expected);
          });
        },
      );
    },
  );

  it('produces byte-identical results on repeat execution', () => {
    for (const entry of loaded) {
      for (const testCase of entry.corpus.cases) {
        const first = JSON.stringify(runConformanceCase(testCase));
        const second = JSON.stringify(runConformanceCase(testCase));
        expect(second).toBe(first);
      }
    }
  });

  it('contains no floating-point-dependent values', () => {
    // Money, quantities and rates are decimal STRINGS. The only numbers a corpus
    // may carry are structural integers that cannot lose precision.
    const STRUCTURAL = new Set([
      'exponent',
      'roundingPrecision',
      'stepMinorUnits',
    ]);
    const offenders: string[] = [];

    const walk = (value: unknown, path: string, key: string | null): void => {
      if (typeof value === 'number') {
        if (!key || !STRUCTURAL.has(key) || !Number.isInteger(value)) {
          offenders.push(`${path} = ${String(value)}`);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`, null));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, k);
      }
    };

    for (const entry of loaded) walk(entry.raw, entry.file, null);
    expect(offenders).toEqual([]);
  });

  it('covers every mandatory tax behaviour this slice implements', () => {
    const ids = loaded
      .flatMap((l) => l.corpus.cases.map((c) => c.id))
      .join(' ');
    for (const required of [
      'inclusive',
      'exclusive',
      'reduced',
      'zero-rated',
      'exempt',
      'quantity',
      'large-amount',
      'exponent-0',
      'exponent-3',
      'half-up',
      'negative',
      'line-level',
      'two-components',
      'order-type-override',
    ]) {
      expect(ids).toContain(required);
    }
  });
});

describe('Conformance corpus validation', () => {
  const valid = () =>
    JSON.parse(JSON.stringify(loaded[0].raw)) as Record<string, unknown>;

  it('rejects a corpus that is not an object', () => {
    expect(() => parseCorpus([], 'x')).toThrow(ConformanceCorpusError);
  });

  it('rejects a numeric corpusVersion', () => {
    expect(() => parseCorpus({ ...valid(), corpusVersion: 1 }, 'x')).toThrow(
      /corpusVersion must be a string/,
    );
  });

  it('rejects an empty case list', () => {
    expect(() => parseCorpus({ ...valid(), cases: [] }, 'x')).toThrow(
      /at least one case/,
    );
  });

  it('rejects a case with no id', () => {
    expect(() =>
      parseCorpus({ ...valid(), cases: [{ description: 'x' }] }, 'x'),
    ).toThrow(/non-empty id/);
  });

  it('rejects duplicate case ids', () => {
    const corpus = valid();
    const cases = corpus.cases as unknown[];
    expect(() =>
      parseCorpus({ ...corpus, cases: [cases[0], cases[0]] }, 'x'),
    ).toThrow(/duplicate case id/);
  });

  it('rejects expectations that do not line up with the inputs', () => {
    const corpus = valid();
    const first = { ...(corpus.cases as Record<string, unknown>[])[0] };
    first.expected = {
      ...(first.expected as Record<string, unknown>),
      lines: [],
    };
    expect(() => parseCorpus({ ...corpus, cases: [first] }, 'x')).toThrow(
      /input lines but 0 expectations/,
    );
  });

  it('rejects a monetary value that is not a string of minor units', () => {
    const corpus = valid();
    const first = JSON.parse(
      JSON.stringify((corpus.cases as unknown[])[0]),
    ) as Record<string, unknown>;
    (first.lines as Record<string, unknown>[])[0].unitPrice = 120.0;
    expect(() => runConformanceCase(first as never)).toThrow(
      /whole number of minor units/,
    );
  });

  it('rejects a case whose pack is malformed', () => {
    const corpus = valid();
    const first = JSON.parse(
      JSON.stringify((corpus.cases as unknown[])[0]),
    ) as Record<string, unknown>;
    (first.pack as Record<string, unknown>).version = '';
    expect(() => runConformanceCase(first as never)).toThrow(
      /countryPack\.version/,
    );
  });

  it('fails loudly when the corpus directory has no corpus in it', () => {
    expect(() => loadTaxCorpus(__dirname)).toThrow(/No corpus file found/);
  });
});
