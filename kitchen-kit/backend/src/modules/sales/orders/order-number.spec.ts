import {
  DEFAULT_BLOCK_SIZE,
  OrderNumberError,
  REFILL_THRESHOLD,
  blockSize,
  formatFallbackOrderNumber,
  formatOrderNumber,
  isExhausted,
  isValidOrderNumber,
  makeBlock,
  needsRefill,
  nextBlockStart,
  remaining,
  takeNext,
} from './order-number';

describe('FR-POS-002 block constants', () => {
  it('defaults to a block of 500', () => {
    expect(DEFAULT_BLOCK_SIZE).toBe(500);
  });

  it('refills at 80% consumed', () => {
    expect(REFILL_THRESHOLD).toBe(0.8);
  });
});

describe('block allocation', () => {
  it('starts at 1 when no block has been issued today', () => {
    expect(nextBlockStart(null)).toBe(1);
  });

  it('starts immediately after the last issued block — blocks never overlap', () => {
    expect(nextBlockStart(500)).toBe(501);
    const first = makeBlock(nextBlockStart(null));
    const second = makeBlock(nextBlockStart(first.blockEnd));
    expect(first.blockEnd).toBe(500);
    expect(second.blockStart).toBe(501);
    expect(second.blockStart).toBeGreaterThan(first.blockEnd);
  });

  it('makes a block of the requested size', () => {
    const b = makeBlock(1, 10);
    expect(blockSize(b)).toBe(10);
    expect(b.blockEnd).toBe(10);
    expect(b.nextSeq).toBe(1);
  });

  it('rejects nonsense block parameters', () => {
    expect(() => makeBlock(0)).toThrow(OrderNumberError);
    expect(() => makeBlock(1, 0)).toThrow(OrderNumberError);
    expect(() => makeBlock(1.5)).toThrow(OrderNumberError);
  });
});

describe('consuming a block', () => {
  it('hands out sequences in order', () => {
    let b = makeBlock(1, 3);
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = takeNext(b);
      seqs.push(r.seq);
      b = r.block;
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(isExhausted(b)).toBe(true);
  });

  it('reports remaining capacity', () => {
    const b = makeBlock(1, 5);
    expect(remaining(b)).toBe(5);
    expect(remaining(takeNext(b).block)).toBe(4);
  });

  it('refuses to hand out past the end rather than silently continuing', () => {
    let b = makeBlock(1, 1);
    b = takeNext(b).block;
    expect(() => takeNext(b)).toThrow(/exhausted/);
  });

  it('signals refill at exactly 80% consumed', () => {
    let b = makeBlock(1, 10);
    for (let i = 0; i < 7; i++) b = takeNext(b).block;
    expect(needsRefill(b)).toBe(false); // 7/10
    b = takeNext(b).block;
    expect(needsRefill(b)).toBe(true); // 8/10
  });
});

describe('formatting (FR-POS-002)', () => {
  it('renders <branch_code>-<seq>', () => {
    expect(formatOrderNumber('CA01', 42)).toBe('CA01-42');
  });

  it('upper-cases the code', () => {
    expect(formatOrderNumber('ca01', 7)).toBe('CA01-7');
  });

  it('renders the offline fallback <terminal_code>-<local_seq>', () => {
    expect(formatFallbackOrderNumber('T7', 3)).toBe('T7-3');
  });

  it('rejects invalid codes and sequences', () => {
    expect(() => formatOrderNumber('bad code', 1)).toThrow(OrderNumberError);
    expect(() => formatOrderNumber('CA01', 0)).toThrow(OrderNumberError);
    expect(() => formatOrderNumber('CA01', 1.5)).toThrow(OrderNumberError);
    expect(() => formatFallbackOrderNumber('', 1)).toThrow(OrderNumberError);
  });

  it('refuses a value that would overflow the VARCHAR(24) column', () => {
    expect(() => formatOrderNumber('ABCDEFGHIJKLMNOP', 1234567890)).toThrow(
      /24-character/,
    );
  });

  it('validates client-supplied (offline-generated) numbers', () => {
    expect(isValidOrderNumber('CA01-42')).toBe(true);
    expect(isValidOrderNumber('T7-1')).toBe(true);
    expect(isValidOrderNumber('lower-1')).toBe(false);
    expect(isValidOrderNumber('NOSEQ')).toBe(false);
    expect(isValidOrderNumber('A'.repeat(30))).toBe(false);
  });
});
