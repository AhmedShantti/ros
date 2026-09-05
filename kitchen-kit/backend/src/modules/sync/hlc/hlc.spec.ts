import {
  HLC_MAX_LOGICAL,
  HLC_MAX_PHYSICAL_MS,
  HlcError,
  compareHlc,
  encodeHlc,
  hlc,
  hlcLocalEvent,
  hlcNodeFromTerminalId,
  hlcReceiveEvent,
  parseHlc,
} from './hlc';

const NODE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const OTHER = '1a2b3c4d5e6f708192a3b4c5d6e7f809';

describe('HLC representation (GD-D1-02)', () => {
  it('derives the node from a terminal UUID by stripping dashes', () => {
    expect(hlcNodeFromTerminalId('0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0')).toBe(
      NODE,
    );
  });

  it('refuses a terminal id that is not a UUID', () => {
    expect(() => hlcNodeFromTerminalId('not-a-uuid')).toThrow(HlcError);
  });

  it('is exactly 52 characters wide, always', () => {
    expect(encodeHlc(hlc(1, 2, NODE))).toHaveLength(52);
    expect(
      encodeHlc(hlc(HLC_MAX_PHYSICAL_MS, HLC_MAX_LOGICAL, NODE)),
    ).toHaveLength(52);
  });

  it('rejects out-of-range components rather than truncating them', () => {
    expect(() => hlc(HLC_MAX_PHYSICAL_MS + 1, 0, NODE)).toThrow(HlcError);
    expect(() => hlc(0, HLC_MAX_LOGICAL + 1, NODE)).toThrow(HlcError);
    expect(() => hlc(-1, 0, NODE)).toThrow(HlcError);
    expect(() => hlc(1.5, 0, NODE)).toThrow(HlcError);
  });

  it('round-trips through the canonical string', () => {
    const value = hlc(1722765753000, 42, NODE);
    expect(parseHlc(encodeHlc(value))).toEqual(value);
  });
});

describe('HLC total order', () => {
  it('is a strict total order over physical, logical and node', () => {
    const values = [
      hlc(1, 0, NODE),
      hlc(1, 0, OTHER),
      hlc(1, 1, NODE),
      hlc(2, 0, NODE),
    ];
    for (let i = 0; i < values.length; i += 1) {
      for (let j = 0; j < values.length; j += 1) {
        const sign = Math.sign(compareHlc(values[i], values[j]));
        expect(sign).toBe(Math.sign(i - j));
      }
    }
  });

  it('agrees with a plain lexicographic sort of the encoded strings', () => {
    const encoded = [
      encodeHlc(hlc(2, 0, NODE)),
      encodeHlc(hlc(1, 1, OTHER)),
      encodeHlc(hlc(1, 0, OTHER)),
      encodeHlc(hlc(1, 0, NODE)),
    ];
    const byComparator = [...encoded].sort((a, b) =>
      compareHlc(parseHlc(a), parseHlc(b)),
    );
    expect([...encoded].sort()).toEqual(byComparator);
  });
});

describe('FR-OFF-041 algorithm properties', () => {
  it('never moves backwards under repeated local events with a stuck clock', () => {
    let state = hlc(1000, 0, NODE);
    for (let i = 0; i < 50; i += 1) {
      const next = hlcLocalEvent(state, 500); // clock frozen in the past
      expect(compareHlc(state, next)).toBeLessThan(0);
      state = next;
    }
    expect(state.physicalMs).toBe(1000);
    expect(state.logical).toBe(50);
  });

  it('never moves backwards under an arbitrary interleaving of receives', () => {
    let state = hlc(1000, 0, NODE);
    const messages = [
      hlc(900, 5, OTHER),
      hlc(1000, 0, OTHER),
      hlc(1200, 3, OTHER),
      hlc(1100, 9, OTHER),
      hlc(1200, 3, OTHER),
    ];
    for (const [i, message] of messages.entries()) {
      const next = hlcReceiveEvent(state, message, 950 + i);
      expect(compareHlc(state, next)).toBeLessThan(0);
      state = next;
    }
  });

  it('a receive never adopts the sender’s node', () => {
    const next = hlcReceiveEvent(hlc(1000, 0, NODE), hlc(2000, 0, OTHER), 1000);
    expect(next.node).toBe(NODE);
  });

  it('fails closed when the logical counter would overflow the wire format', () => {
    // The 5-digit field is part of the ratified representation. Truncating
    // would silently corrupt causal order, so it must throw instead.
    expect(() => hlcLocalEvent(hlc(1000, HLC_MAX_LOGICAL, NODE), 1000)).toThrow(
      HlcError,
    );
  });

  it('rejects a non-integer physical time on both entry points', () => {
    expect(() => hlcLocalEvent(hlc(1000, 0, NODE), Number.NaN)).toThrow(
      HlcError,
    );
    expect(() =>
      hlcReceiveEvent(hlc(1000, 0, NODE), hlc(1, 0, OTHER), -1),
    ).toThrow(HlcError);
  });
});
