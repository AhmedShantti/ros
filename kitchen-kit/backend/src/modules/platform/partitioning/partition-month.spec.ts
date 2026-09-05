import {
  addMonths,
  partitionBounds,
  partitionTableName,
  requiredMonths,
  yearMonthKey,
  yearMonthOf,
} from './partition-month';

describe('partition-month — pure calendar arithmetic (no database)', () => {
  describe('yearMonthOf / yearMonthKey', () => {
    it('reads the UTC calendar month, not the local one', () => {
      // 2026-09-03T00:30:00Z is still September 3rd in UTC even if the host
      // machine's local zone would put it on the 2nd — the point of using
      // getUTCFullYear/getUTCMonth throughout.
      const ym = yearMonthOf(new Date('2026-09-03T00:30:00.000Z'));
      expect(ym).toEqual({ year: 2026, month: 9 });
      expect(yearMonthKey(ym)).toBe('2026-09');
    });

    it('pads single-digit months', () => {
      expect(yearMonthKey({ year: 2026, month: 1 })).toBe('2026-01');
    });
  });

  describe('addMonths', () => {
    it('adds within a year', () => {
      expect(addMonths({ year: 2026, month: 9 }, 2)).toEqual({
        year: 2026,
        month: 11,
      });
    });

    it('rolls over a December -> January year boundary', () => {
      expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({
        year: 2027,
        month: 2,
      });
    });

    it('rolls over exactly at the boundary (December + 1)', () => {
      expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({
        year: 2027,
        month: 1,
      });
    });

    it('is correct for a multi-year jump', () => {
      expect(addMonths({ year: 2026, month: 6 }, 30)).toEqual({
        year: 2028,
        month: 12,
      });
    });

    it('supports negative deltas (used internally by bounds, not by the job)', () => {
      expect(addMonths({ year: 2027, month: 1 }, -1)).toEqual({
        year: 2026,
        month: 12,
      });
    });
  });

  describe('requiredMonths — FR-DR-002 "at least 3 months in advance"', () => {
    it('returns the current month plus the next 3, inclusive: 4 months total', () => {
      const months = requiredMonths(new Date('2026-09-03T00:00:00.000Z'), 3);
      expect(months.map(yearMonthKey)).toEqual([
        '2026-09',
        '2026-10',
        '2026-11',
        '2026-12',
      ]);
    });

    it('spans a year boundary correctly', () => {
      const months = requiredMonths(new Date('2026-11-15T00:00:00.000Z'), 3);
      expect(months.map(yearMonthKey)).toEqual([
        '2026-11',
        '2026-12',
        '2027-01',
        '2027-02',
      ]);
    });

    it('a horizon of 0 returns only the current month', () => {
      const months = requiredMonths(new Date('2026-09-03T00:00:00.000Z'), 0);
      expect(months.map(yearMonthKey)).toEqual(['2026-09']);
    });
  });

  describe('partitionTableName', () => {
    it('matches the naming already used by every existing partition', () => {
      expect(
        partitionTableName('stock_movements', { year: 2026, month: 8 }),
      ).toBe('stock_movements_2026_08');
      expect(partitionTableName('orders', { year: 2027, month: 1 })).toBe(
        'orders_2027_01',
      );
    });
  });

  describe('partitionBounds', () => {
    it('bounds an ordinary month', () => {
      expect(partitionBounds({ year: 2026, month: 9 })).toEqual({
        from: '2026-09-01',
        to: '2026-10-01',
      });
    });

    it('bounds December -> January correctly (year/month boundary)', () => {
      expect(partitionBounds({ year: 2026, month: 12 })).toEqual({
        from: '2026-12-01',
        to: '2027-01-01',
      });
    });

    it('bounds February in a leap year (2028) with a 29-day month, correctly delegated to month-grain arithmetic', () => {
      // Month-grain RANGE bounds never mention day-of-month 29/30/31 — the
      // upper bound is always "the 1st of next month" regardless of how many
      // days February actually has, so leap years are handled BY
      // CONSTRUCTION rather than by any special-cased logic here. This test
      // exists to make that fact explicit and pin it against regression.
      expect(partitionBounds({ year: 2028, month: 2 })).toEqual({
        from: '2028-02-01',
        to: '2028-03-01',
      });
      // And the non-leap year immediately before it is identical in shape.
      expect(partitionBounds({ year: 2027, month: 2 })).toEqual({
        from: '2027-02-01',
        to: '2027-03-01',
      });
    });

    it('produces two adjacent bounds with no gap and no overlap for consecutive months', () => {
      const a = partitionBounds({ year: 2026, month: 9 });
      const b = partitionBounds({ year: 2026, month: 10 });
      expect(a.to).toBe(b.from);
    });
  });
});
