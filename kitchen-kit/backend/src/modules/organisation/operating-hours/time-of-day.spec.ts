import {
  formatTimeOfDay,
  intervalsOverlap,
  minutesOfDay,
  parseTimeOfDay,
  toRange,
} from './time-of-day';

describe('time-of-day', () => {
  describe('parseTimeOfDay', () => {
    it('parses HH:MM and HH:MM:SS', () => {
      expect(formatTimeOfDay(parseTimeOfDay('09:30'))).toBe('09:30:00');
      expect(formatTimeOfDay(parseTimeOfDay('23:59:59'))).toBe('23:59:59');
      expect(minutesOfDay(parseTimeOfDay('01:15'))).toBe(75);
    });

    it('rejects malformed or out-of-range values', () => {
      for (const bad of ['24:00', '9:30', '12:60', '', 'noon', '12:30:61']) {
        expect(() => parseTimeOfDay(bad)).toThrow();
      }
    });
  });

  describe('toRange', () => {
    it('keeps a same-day interval within the day', () => {
      expect(
        toRange({
          opensAt: parseTimeOfDay('09:00'),
          closesAt: parseTimeOfDay('17:00'),
        }),
      ).toEqual([540, 1020]);
    });

    it('extends an overnight interval past midnight', () => {
      // SRS glossary: "A branch closing at 03:00 attributes those sales to the
      // previous business day."
      expect(
        toRange({
          opensAt: parseTimeOfDay('20:00'),
          closesAt: parseTimeOfDay('03:00'),
        }),
      ).toEqual([1200, 1620]);
    });

    it('treats an equal open/close as a full 24h wrap, not a zero-length span', () => {
      expect(
        toRange({
          opensAt: parseTimeOfDay('06:00'),
          closesAt: parseTimeOfDay('06:00'),
        }),
      ).toEqual([360, 1800]);
    });
  });

  describe('intervalsOverlap (ADR 0008 D-04)', () => {
    const iv = (o: string, c: string) => ({
      opensAt: parseTimeOfDay(o),
      closesAt: parseTimeOfDay(c),
    });

    it('permits split shifts that do not overlap', () => {
      expect(intervalsOverlap(iv('11:00', '15:00'), iv('18:00', '23:00'))).toBe(
        false,
      );
    });

    it('treats touching boundaries as non-overlapping', () => {
      expect(intervalsOverlap(iv('09:00', '12:00'), iv('12:00', '17:00'))).toBe(
        false,
      );
    });

    it('detects a partial overlap', () => {
      expect(intervalsOverlap(iv('11:00', '15:00'), iv('14:00', '20:00'))).toBe(
        true,
      );
    });

    it('detects containment', () => {
      expect(intervalsOverlap(iv('09:00', '22:00'), iv('12:00', '13:00'))).toBe(
        true,
      );
    });

    it('detects an identical interval', () => {
      expect(intervalsOverlap(iv('09:00', '17:00'), iv('09:00', '17:00'))).toBe(
        true,
      );
    });

    it('detects an overnight interval overlapping a late-evening one', () => {
      expect(intervalsOverlap(iv('20:00', '03:00'), iv('22:00', '23:30'))).toBe(
        true,
      );
    });

    it('permits an overnight interval alongside a non-overlapping morning one', () => {
      // 20:00–03:00 normalises to [1200, 1620); 08:00–12:00 is [480, 720).
      expect(intervalsOverlap(iv('20:00', '03:00'), iv('08:00', '12:00'))).toBe(
        false,
      );
    });

    it('is symmetric', () => {
      const a = iv('11:00', '15:00');
      const b = iv('14:00', '20:00');
      expect(intervalsOverlap(a, b)).toBe(intervalsOverlap(b, a));
    });
  });
});
