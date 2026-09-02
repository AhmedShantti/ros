import {
  HLC_CORPUS_DIR,
  HlcCompareCase,
  HlcCorpusError,
  corpusInt,
  loadHlcCorpus,
} from './hlc-conformance.runner';
import {
  compareHlc,
  encodeHlc,
  hlc,
  hlcLocalEvent,
  hlcReceiveEvent,
  isValidHlc,
  parseHlc,
} from './hlc';

/**
 * The TypeScript half of the shared HLC conformance suite (`FR-OFF-050`,
 * `CT-06`, `CT-10`). Every expectation comes from
 * `kitchen-kit/conformance/hlc/`, hand-derived from `FR-OFF-041` as printed in
 * the SRS — never from this implementation's output.
 */
describe('FR-OFF-041 HLC conformance corpus', () => {
  const loaded = loadHlcCorpus();

  it('is located outside the backend package, so neither runtime owns it', () => {
    expect(HLC_CORPUS_DIR).toMatch(/kitchen-kit\/conformance\/hlc$/);
    expect(loaded.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a corpus directory with no corpus files', () => {
    expect(() => loadHlcCorpus(__dirname)).toThrow(HlcCorpusError);
  });

  const expectCompare = (c: HlcCompareCase) => {
    const sign = compareHlc(parseHlc(c.a), parseHlc(c.b));
    const actual = sign < 0 ? 'lt' : sign > 0 ? 'gt' : 'eq';
    expect(`${c.id}:${actual}`).toBe(`${c.id}:${c.expected}`);
    // The fixed-width encoding must make a plain string comparison agree.
    const lexical = c.a < c.b ? 'lt' : c.a > c.b ? 'gt' : 'eq';
    expect(`${c.id}:lexical:${lexical}`).toBe(`${c.id}:lexical:${c.expected}`);
  };

  for (const { file, corpus } of loaded) {
    describe(file, () => {
      for (const c of corpus.localEvent ?? []) {
        it(`local event: ${c.id}`, () => {
          const state = parseHlc(c.state);
          const pt = corpusInt(c.physicalMs, 'physicalMs');
          if (c.expectError) {
            expect(() => hlcLocalEvent(state, pt)).toThrow();
            return;
          }
          expect(encodeHlc(hlcLocalEvent(state, pt))).toBe(c.expected);
        });
      }

      for (const c of [
        ...(corpus.receiveEvent ?? []),
        ...(corpus.sequence ?? []),
      ]) {
        it(`receive event: ${c.id}`, () => {
          const state = parseHlc(c.state);
          const message = parseHlc(c.message);
          const pt = corpusInt(c.physicalMs, 'physicalMs');
          if (c.expectError) {
            expect(() => hlcReceiveEvent(state, message, pt)).toThrow();
            return;
          }
          const next = hlcReceiveEvent(state, message, pt);
          expect(encodeHlc(next)).toBe(c.expected);
          // The receiver always keeps its OWN node.
          expect(next.node).toBe(state.node);
        });
      }

      for (const c of [...(corpus.compare ?? []), ...(corpus.ordering ?? [])]) {
        it(`compare: ${c.id}`, () => expectCompare(c));
      }

      for (const c of corpus.sort ?? []) {
        it(`sort: ${c.id}`, () => {
          const byComparator = [...c.input].sort((a, b) =>
            compareHlc(parseHlc(a), parseHlc(b)),
          );
          expect(byComparator).toEqual([...c.expectedOrder]);
          // Sorting the raw strings must give the identical answer — this is
          // the property that lets PostgreSQL ORDER BY hlc be the causal order.
          expect([...c.input].sort()).toEqual([...c.expectedOrder]);
        });
      }

      for (const c of corpus.encoding ?? []) {
        it(`encoding: ${c.id}`, () => {
          const value = hlc(
            corpusInt(c.physicalMs, 'physicalMs'),
            corpusInt(c.logical, 'logical'),
            c.node,
          );
          expect(encodeHlc(value)).toBe(c.expected);
          // Round-trips exactly.
          expect(encodeHlc(parseHlc(c.expected))).toBe(c.expected);
        });
      }

      for (const c of corpus.malformed ?? []) {
        it(`malformed fails closed: ${c.id}`, () => {
          expect(isValidHlc(c.raw)).toBe(false);
          expect(() => parseHlc(c.raw)).toThrow();
        });
      }
    });
  }
});

describe('CT-10 — device clock three hours ahead', () => {
  const [, ct10] = loadHlcCorpus().sort((a, b) => a.file.localeCompare(b.file));

  it('is the CT-10 corpus, and states the skew it models', () => {
    expect(ct10.file).toContain('ct10');
    expect(
      corpusInt(ct10.corpus['skewMs' as never] as unknown as string, 'skewMs'),
    ).toBe(3 * 60 * 60 * 1000);
  });

  it('preserves ordering across the whole skewed sequence', () => {
    // Replaying the corpus sequence must produce a STRICTLY INCREASING server
    // clock: causality is preserved even though one device is three hours out.
    let state = parseHlc((ct10.corpus.sequence ?? [])[0].state);
    for (const step of ct10.corpus.sequence ?? []) {
      const next = hlcReceiveEvent(
        parseHlc(step.state),
        parseHlc(step.message),
        corpusInt(step.physicalMs, 'physicalMs'),
      );
      expect(encodeHlc(next)).toBe(step.expected);
      expect(compareHlc(state, next)).toBeLessThanOrEqual(0);
      state = next;
    }
  });
});
