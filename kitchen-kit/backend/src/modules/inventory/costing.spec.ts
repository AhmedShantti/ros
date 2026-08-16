import {
  BatchLot,
  defaultBatchStrategy,
  defaultExpiryDate,
  selectBatches,
  totalCost,
  valuationUnitCost,
  weightedAverageCost,
} from './costing';

const lot = (
  id: string,
  qty: number,
  cost: bigint,
  received: string,
  expiry: string | null,
): BatchLot => ({
  batchId: id,
  quantityRemaining: qty,
  unitCost: cost,
  receivedAt: new Date(received),
  expiryDate: expiry ? new Date(expiry) : null,
});

describe('batch selection (FR-INV-022/023) — selection only, never costing', () => {
  // Deliberately: the LATER delivery expires FIRST — the case the SRS calls out
  // as why FEFO exists ("suppliers rotate their own stock").
  const lots = [
    lot('old', 10, 100n, '2026-08-01', '2026-12-31'),
    lot('new', 10, 200n, '2026-08-10', '2026-09-01'),
  ];

  it('FIFO consumes the oldest received batch first', () => {
    const { consumed, shortfall } = selectBatches(lots, 6, 'fifo');
    expect(consumed).toEqual([{ batchId: 'old', quantity: 6, unitCost: 100n }]);
    expect(shortfall).toBe(0);
  });

  it('FEFO consumes the nearest-expiry batch first, even if received later', () => {
    const { consumed } = selectBatches(lots, 6, 'fefo');
    expect(consumed).toEqual([{ batchId: 'new', quantity: 6, unitCost: 200n }]);
  });

  it('spans multiple batches in order when one is insufficient', () => {
    const { consumed, shortfall } = selectBatches(lots, 15, 'fifo');
    expect(consumed).toEqual([
      { batchId: 'old', quantity: 10, unitCost: 100n },
      { batchId: 'new', quantity: 5, unitCost: 200n },
    ]);
    expect(shortfall).toBe(0);
  });

  it('reports a shortfall rather than throwing (FR-INV-014 permits negative stock)', () => {
    const { consumed, shortfall } = selectBatches(lots, 25, 'fifo');
    expect(consumed.reduce((s, c) => s + c.quantity, 0)).toBe(20);
    expect(shortfall).toBe(5);
  });

  it('FEFO sorts batches without an expiry last, then by receipt order', () => {
    const mixed = [
      lot('noexp-late', 5, 100n, '2026-08-20', null),
      lot('noexp-early', 5, 100n, '2026-08-02', null),
      lot('exp', 5, 100n, '2026-08-15', '2026-10-01'),
    ];
    const { consumed } = selectBatches(mixed, 15, 'fefo');
    expect(consumed.map((c) => c.batchId)).toEqual([
      'exp',
      'noexp-early',
      'noexp-late',
    ]);
  });

  it('skips exhausted batches', () => {
    const withEmpty = [lot('empty', 0, 100n, '2026-08-01', null), ...lots];
    const { consumed } = selectBatches(withEmpty, 3, 'fifo');
    expect(consumed[0].batchId).toBe('old');
  });

  it('returns nothing for a non-positive quantity', () => {
    expect(selectBatches(lots, 0, 'fifo')).toEqual({
      consumed: [],
      shortfall: 0,
    });
  });
});

describe('weighted average (FR-INV-012)', () => {
  it('recomputes on receipt', () => {
    // 10 @ 100 + 10 @ 200 => 150
    expect(weightedAverageCost(10, 100n, 10, 200n)).toBe(150n);
  });

  it('is the received cost when there is no existing stock', () => {
    expect(weightedAverageCost(0, 0n, 5, 250n)).toBe(250n);
  });

  it('rounds half-up to whole minor units', () => {
    // (1*100 + 2*101)/3 = 100.666… -> 101
    expect(weightedAverageCost(1, 100n, 2, 101n)).toBe(101n);
  });

  it('leaves the average unchanged when the resulting quantity is not positive', () => {
    expect(weightedAverageCost(5, 120n, -5, 999n)).toBe(120n);
  });
});

describe('valuation (D-INV-03) — independent of batch selection', () => {
  const consumed = [
    { batchId: 'a', quantity: 4, unitCost: 100n },
    { batchId: 'b', quantity: 6, unitCost: 200n },
  ];

  it('weighted_average uses the prevailing average and ignores the batch plan', () => {
    expect(
      valuationUnitCost({
        costingMethod: 'weighted_average',
        quantity: 10,
        averageCost: 150n,
        standardCost: 999n,
        consumed,
      }),
    ).toBe(150n);
  });

  it('standard uses the item standard cost and ignores both average and batches', () => {
    expect(
      valuationUnitCost({
        costingMethod: 'standard',
        quantity: 10,
        averageCost: 150n,
        standardCost: 175n,
        consumed,
      }),
    ).toBe(175n);
  });

  it('fifo uses the value-weighted cost of the batches actually consumed', () => {
    // (4*100 + 6*200)/10 = 160
    expect(
      valuationUnitCost({
        costingMethod: 'fifo',
        quantity: 10,
        averageCost: 150n,
        standardCost: null,
        consumed,
      }),
    ).toBe(160n);
  });

  it('fifo falls back to the average when no batches were consumed', () => {
    expect(
      valuationUnitCost({
        costingMethod: 'fifo',
        quantity: 10,
        averageCost: 150n,
        standardCost: null,
        consumed: [],
      }),
    ).toBe(150n);
  });

  it('FEFO selection with FIFO costing values the batches FEFO chose', () => {
    // The combination the SRS leaves undefined: selection and valuation stay
    // independent, and the consumed plan is what gets valued.
    const lots = [
      lot('old-cheap', 10, 100n, '2026-08-01', '2026-12-31'),
      lot('new-dear', 10, 300n, '2026-08-10', '2026-09-01'),
    ];
    const { consumed: fefoPlan } = selectBatches(lots, 5, 'fefo');
    expect(fefoPlan[0].batchId).toBe('new-dear');
    expect(
      valuationUnitCost({
        costingMethod: 'fifo',
        quantity: 5,
        averageCost: 200n,
        standardCost: null,
        consumed: fefoPlan,
      }),
    ).toBe(300n);
  });
});

describe('helpers', () => {
  it('totalCost multiplies on absolute quantity (movements are signed)', () => {
    expect(totalCost(-3, 250n)).toBe(750n);
    expect(totalCost(3, 250n)).toBe(750n);
  });

  it('defaultExpiryDate adds shelf life to the production date (FR-INV-021)', () => {
    expect(
      defaultExpiryDate(new Date('2026-08-01T00:00:00Z'), 14)?.toISOString(),
    ).toBe('2026-08-15T00:00:00.000Z');
  });

  it('defaultExpiryDate is null without both inputs', () => {
    expect(defaultExpiryDate(null, 14)).toBeNull();
    expect(
      defaultExpiryDate(new Date('2026-08-01T00:00:00Z'), null),
    ).toBeNull();
  });

  it('FEFO is the default strategy for expiry-tracked items (FR-INV-023)', () => {
    expect(defaultBatchStrategy(true)).toBe('fefo');
    expect(defaultBatchStrategy(false)).toBe('fifo');
  });
});
