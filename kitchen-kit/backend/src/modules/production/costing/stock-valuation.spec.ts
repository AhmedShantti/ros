import { Prisma } from '../../../generated/prisma/client';
import { StockValuationService } from './stock-valuation.service';

/**
 * FR-INV-001 — every stock item is valued by ITS OWN configured costing method.
 * These tests pin the dispatch and, just as importantly, pin that no method ever
 * falls back to another when its own data is absent.
 */

type ItemRow = {
  id: string;
  costingMethod: string;
  standardCost: bigint | null;
};
type LevelRow = {
  stockItemId: string;
  quantityOnHand: Prisma.Decimal;
  averageCost: bigint;
  lastMovementOccurredAt: Date | null;
};
type BatchRow = { stockItemId: string; unitCost: bigint; createdAt: Date };

/**
 * A stub transaction client.
 *
 * Deliberately not a mock of the whole Prisma surface: it answers exactly the
 * three queries this service makes, so a change in what it asks for shows up as
 * a broken test rather than as a silently satisfied mock.
 */
function stubTx(data: {
  items: ItemRow[];
  levels?: LevelRow[];
  batches?: BatchRow[];
}): Prisma.TransactionClient {
  const levels = data.levels ?? [];
  const batches = [...(data.batches ?? [])].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return {
    stockItem: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(data.items.filter((i) => where.id.in.includes(i.id))),
    },
    stockLevel: {
      findMany: ({ where }: { where: { stockItemId: { in: string[] } } }) =>
        Promise.resolve(
          levels.filter((l) => where.stockItemId.in.includes(l.stockItemId)),
        ),
    },
    stockBatch: {
      findMany: ({ where }: { where: { stockItemId: { in: string[] } } }) =>
        Promise.resolve(
          batches.filter(
            (b) =>
              where.stockItemId.in.includes(b.stockItemId) && b.unitCost >= 0n,
          ),
        ),
    },
  } as unknown as Prisma.TransactionClient;
}

const dec = (v: string) => new Prisma.Decimal(v);
const service = new StockValuationService();

describe('Stock valuation dispatch (FR-INV-001)', () => {
  it('values a `standard` item at its standard cost', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [{ id: 'a', costingMethod: 'standard', standardCost: 1_250n }],
      }),
      ['a'],
    );
    expect(result.get('a')).toEqual({
      stockItemId: 'a',
      method: 'standard',
      costPerBaseUnit: { num: 1_250n, den: 1n },
    });
  });

  it('reports a `standard` item with no standard cost as UNKNOWN, not free', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [{ id: 'a', costingMethod: 'standard', standardCost: null }],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toBeNull();
  });

  it('values a `weighted_average` item at the prevailing average', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('10'),
            averageCost: 500n,
            lastMovementOccurredAt: new Date('2026-08-01'),
          },
        ],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 500n, den: 1n });
  });

  it('weights the average by quantity across locations', async () => {
    // 10 @ 500 and 30 @ 900 -> (5000 + 27000) / 40 = 800.
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('10'),
            averageCost: 500n,
            lastMovementOccurredAt: new Date('2026-08-01'),
          },
          {
            stockItemId: 'a',
            quantityOnHand: dec('30'),
            averageCost: 900n,
            lastMovementOccurredAt: new Date('2026-08-02'),
          },
        ],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 800n, den: 1n });
  });

  it('weights fractional quantities exactly', async () => {
    // 0.5 @ 300 and 1.5 @ 700 -> (150 + 1050) / 2 = 600.
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('0.5'),
            averageCost: 300n,
            lastMovementOccurredAt: null,
          },
          {
            stockItemId: 'a',
            quantityOnHand: dec('1.5'),
            averageCost: 700n,
            lastMovementOccurredAt: null,
          },
        ],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 600n, den: 1n });
  });

  it('ignores locations holding nothing when others hold stock', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('0'),
            averageCost: 100n,
            lastMovementOccurredAt: new Date('2026-08-05'),
          },
          {
            stockItemId: 'a',
            quantityOnHand: dec('4'),
            averageCost: 900n,
            lastMovementOccurredAt: new Date('2026-08-01'),
          },
        ],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 900n, den: 1n });
  });

  it('falls back to the most recently observed average when nothing is held', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('0'),
            averageCost: 100n,
            lastMovementOccurredAt: new Date('2026-07-01'),
          },
          {
            stockItemId: 'a',
            quantityOnHand: dec('0'),
            averageCost: 250n,
            lastMovementOccurredAt: new Date('2026-08-01'),
          },
        ],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 250n, den: 1n });
  });

  it('reports a `weighted_average` item never stocked as UNKNOWN', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'a', costingMethod: 'weighted_average', standardCost: null },
        ],
        levels: [],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toBeNull();
  });

  it('values a `fifo` item at the OLDEST remaining layer (FR-INV-013)', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [{ id: 'a', costingMethod: 'fifo', standardCost: null }],
        batches: [
          {
            stockItemId: 'a',
            unitCost: 900n,
            createdAt: new Date('2026-08-05'),
          },
          {
            stockItemId: 'a',
            unitCost: 400n,
            createdAt: new Date('2026-08-01'),
          },
        ],
      }),
      ['a'],
    );
    // The next unit consumed comes from the 2026-08-01 layer.
    expect(result.get('a')!.costPerBaseUnit).toEqual({ num: 400n, den: 1n });
  });

  it('reports a `fifo` item with no layers as UNKNOWN — it does NOT fake FIFO', async () => {
    // A level with an average IS present. A fallback to it would be a fabricated
    // FIFO cost, which is exactly what must not happen.
    const result = await service.valuationsFor(
      stubTx({
        items: [{ id: 'a', costingMethod: 'fifo', standardCost: 777n }],
        levels: [
          {
            stockItemId: 'a',
            quantityOnHand: dec('99'),
            averageCost: 555n,
            lastMovementOccurredAt: new Date('2026-08-01'),
          },
        ],
        batches: [],
      }),
      ['a'],
    );
    expect(result.get('a')!.costPerBaseUnit).toBeNull();
  });

  it('never applies one item’s method to another', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [
          { id: 'fifo-item', costingMethod: 'fifo', standardCost: null },
          { id: 'std-item', costingMethod: 'standard', standardCost: 4_200n },
          {
            id: 'wa-item',
            costingMethod: 'weighted_average',
            standardCost: null,
          },
        ],
        levels: [
          {
            stockItemId: 'wa-item',
            quantityOnHand: dec('2'),
            averageCost: 111n,
            lastMovementOccurredAt: null,
          },
        ],
        batches: [
          {
            stockItemId: 'fifo-item',
            unitCost: 333n,
            createdAt: new Date('2026-08-01'),
          },
        ],
      }),
      ['fifo-item', 'std-item', 'wa-item'],
    );

    expect(result.get('fifo-item')!.costPerBaseUnit).toEqual({
      num: 333n,
      den: 1n,
    });
    expect(result.get('std-item')!.costPerBaseUnit).toEqual({
      num: 4_200n,
      den: 1n,
    });
    expect(result.get('wa-item')!.costPerBaseUnit).toEqual({
      num: 111n,
      den: 1n,
    });
    expect(result.get('fifo-item')!.method).toBe('fifo');
    expect(result.get('std-item')!.method).toBe('standard');
    expect(result.get('wa-item')!.method).toBe('weighted_average');
  });

  it('returns nothing for an empty request', async () => {
    expect((await service.valuationsFor(stubTx({ items: [] }), [])).size).toBe(
      0,
    );
  });

  it('de-duplicates repeated ids', async () => {
    const result = await service.valuationsFor(
      stubTx({
        items: [{ id: 'a', costingMethod: 'standard', standardCost: 1n }],
      }),
      ['a', 'a', 'a'],
    );
    expect(result.size).toBe(1);
  });
});
