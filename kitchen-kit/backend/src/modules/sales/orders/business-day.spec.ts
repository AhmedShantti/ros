import {
  BusinessDayError,
  cutoverMinutes,
  resolveBusinessDay,
  toLocalDateTime,
} from './business-day';

const CAIRO = 'Africa/Cairo';
const day = (d: Date) => d.toISOString().slice(0, 10);
const at0000 = () => 0;
const at0400 = () => 4 * 60;

describe('Business-day resolution (FR-FIN-024)', () => {
  it('attributes an instant to its local calendar day with a midnight boundary', () => {
    expect(
      day(resolveBusinessDay(new Date('2026-08-20T09:00:00Z'), CAIRO, at0000)),
    ).toBe('2026-08-20');
  });

  it('attributes late-night trading before the boundary to the previous day', () => {
    // 02:00 local on the 21st, boundary 04:00 -> still the 20th's business day.
    expect(
      day(resolveBusinessDay(new Date('2026-08-20T23:00:00Z'), CAIRO, at0400)),
    ).toBe('2026-08-20');
  });

  it('rolls over exactly at the boundary, not before it', () => {
    // 03:59 local -> previous day; 04:00 local -> the new day.
    expect(
      day(resolveBusinessDay(new Date('2026-08-21T00:59:00Z'), CAIRO, at0400)),
    ).toBe('2026-08-20');
    expect(
      day(resolveBusinessDay(new Date('2026-08-21T01:00:00Z'), CAIRO, at0400)),
    ).toBe('2026-08-21');
  });

  it('crosses a month boundary backwards correctly', () => {
    expect(
      day(resolveBusinessDay(new Date('2026-09-01T00:30:00Z'), CAIRO, at0400)),
    ).toBe('2026-08-31');
  });

  it('uses the branch timezone, never the server timezone', () => {
    // 22:00 UTC is already the next calendar day in Cairo (UTC+3 in August).
    const instant = new Date('2026-08-20T22:00:00Z');
    expect(day(resolveBusinessDay(instant, CAIRO, at0000))).toBe('2026-08-21');
    expect(day(resolveBusinessDay(instant, 'UTC', at0000))).toBe('2026-08-20');
  });

  it('consults the cutover of the local calendar date', () => {
    const seen: number[] = [];
    resolveBusinessDay(new Date('2026-08-20T09:00:00Z'), CAIRO, (w) => {
      seen.push(w);
      return 0;
    });
    // 2026-08-20 is a Thursday.
    expect(seen).toEqual([4]);
  });

  it('rejects an unknown timezone rather than silently using UTC', () => {
    expect(() =>
      resolveBusinessDay(new Date(), 'Mars/Olympus_Mons', at0000),
    ).toThrow(BusinessDayError);
  });

  it('rejects an impossible cutover', () => {
    expect(() => resolveBusinessDay(new Date(), CAIRO, () => 24 * 60)).toThrow(
      /minute of the day/,
    );
    expect(() => resolveBusinessDay(new Date(), CAIRO, () => -1)).toThrow(
      /minute of the day/,
    );
  });

  it('returns UTC midnight so a DATE column round-trips exactly', () => {
    const resolved = resolveBusinessDay(
      new Date('2026-08-20T09:00:00Z'),
      CAIRO,
      at0000,
    );
    expect(resolved.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });
});

describe('cutoverMinutes', () => {
  it('reads a Prisma TIME value', () => {
    expect(cutoverMinutes(new Date('1970-01-01T04:00:00Z'))).toBe(240);
    expect(cutoverMinutes(new Date('1970-01-01T00:00:00Z'))).toBe(0);
  });

  it('reads an HH:MM[:SS] string', () => {
    expect(cutoverMinutes('04:00')).toBe(240);
    expect(cutoverMinutes('04:30:00')).toBe(270);
  });

  it('treats an absent boundary as midnight, matching the column default', () => {
    expect(cutoverMinutes(null)).toBe(0);
    expect(cutoverMinutes(undefined)).toBe(0);
  });

  it('rejects a malformed TIME rather than guessing', () => {
    expect(() => cutoverMinutes('4am')).toThrow(BusinessDayError);
  });
});

describe('toLocalDateTime', () => {
  it('projects an instant onto branch-local fields', () => {
    const local = toLocalDateTime(new Date('2026-08-20T09:15:00Z'), CAIRO);
    expect(local).toEqual({
      year: 2026,
      month: 8,
      day: 20,
      weekdayIndex: 4,
      minutes: 12 * 60 + 15,
    });
  });
});
