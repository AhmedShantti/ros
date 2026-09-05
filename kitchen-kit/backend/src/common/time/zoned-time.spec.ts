import {
  ZonedTimeError,
  dueDailySlots,
  instantForLocalSlot,
  localSlotKey,
  parseLocalSlotKey,
  projectToZone,
} from './zoned-time';

/**
 * SCHED-1 — the timezone/DST kernel the scheduler's occurrence identity rests
 * on. Every assertion here is on a FIXED instant and a FIXED IANA zone, so
 * nothing depends on when the suite runs, on the machine's own timezone, or on
 * the current tz database's future predictions.
 *
 * The DST transitions used are real and were confirmed against this runtime's
 * ICU data before being written down:
 *   Europe/London  2026-03-29  01:00 UTC — local 01:00 -> 02:00 (01:00..01:59 SKIPPED)
 *   Europe/London  2026-10-25  01:00 UTC — local 02:00 -> 01:00 (01:00..01:59 REPEATED)
 *   Africa/Cairo   2026-04-23  22:00 UTC — local 04-23 24:00 -> 04-24 01:00
 *                                            (04-24 00:00..00:59 SKIPPED)
 *   Africa/Cairo   2026-10-29  21:00 UTC — local 24:00 -> 23:00 (23:00..23:59 REPEATED)
 */
const LONDON = 'Europe/London';
const CAIRO = 'Africa/Cairo';
const iso = (d: Date) => d.toISOString();

describe('projectToZone', () => {
  it('projects an instant onto a zone calendar and wall clock', () => {
    expect(projectToZone(new Date('2026-08-20T09:15:00Z'), CAIRO)).toEqual({
      year: 2026,
      month: 8,
      day: 20,
      minutes: 12 * 60 + 15,
    });
  });

  it('renders local midnight as 0 minutes, never 1440', () => {
    // 2026-01-15 00:30 Cairo is 22:30Z the previous day (UTC+2 in winter).
    expect(projectToZone(new Date('2026-01-14T22:00:00Z'), CAIRO).minutes).toBe(
      0,
    );
  });

  it('rejects an unknown IANA zone rather than silently falling back to UTC', () => {
    expect(() => projectToZone(new Date(), 'Mars/Olympus_Mons')).toThrow(
      ZonedTimeError,
    );
  });
});

describe('localSlotKey / parseLocalSlotKey', () => {
  it('renders a fixed-width, lexicographically ordered key', () => {
    expect(
      localSlotKey({ year: 2026, month: 9, day: 3, minutes: 3 * 60 }),
    ).toBe('2026-09-03T03:00');
    expect(
      localSlotKey({ year: 2026, month: 12, day: 31, minutes: 1439 }),
    ).toBe('2026-12-31T23:59');
  });

  it('round-trips', () => {
    const slot = { year: 2026, month: 3, day: 29, minutes: 90 };
    expect(parseLocalSlotKey(localSlotKey(slot))).toEqual(slot);
  });

  it('lexicographic order IS chronological order, which is what the DB index relies on', () => {
    const keys = [
      localSlotKey({ year: 2026, month: 9, day: 9, minutes: 180 }),
      localSlotKey({ year: 2026, month: 9, day: 10, minutes: 60 }),
      localSlotKey({ year: 2026, month: 10, day: 1, minutes: 0 }),
    ];
    expect([...keys].sort()).toEqual(keys);
  });

  it('rejects a malformed key rather than guessing', () => {
    expect(() => parseLocalSlotKey('2026-9-3T3:00')).toThrow(ZonedTimeError);
    expect(() => parseLocalSlotKey('')).toThrow(ZonedTimeError);
  });

  it('rejects a minute-of-day outside 0..1439', () => {
    expect(() =>
      localSlotKey({ year: 2026, month: 1, day: 1, minutes: 1440 }),
    ).toThrow(ZonedTimeError);
    expect(() =>
      localSlotKey({ year: 2026, month: 1, day: 1, minutes: -1 }),
    ).toThrow(ZonedTimeError);
  });
});

describe('instantForLocalSlot — ordinary days', () => {
  it('resolves a winter (standard-offset) slot', () => {
    // Cairo is UTC+2 in January.
    expect(
      iso(
        instantForLocalSlot(
          { year: 2026, month: 1, day: 15, minutes: 180 },
          CAIRO,
        ),
      ),
    ).toBe('2026-01-15T01:00:00.000Z');
  });

  it('resolves a summer (DST-offset) slot in the same zone differently', () => {
    // Cairo is UTC+3 in July, so the same local 03:00 is an hour earlier in UTC.
    expect(
      iso(
        instantForLocalSlot(
          { year: 2026, month: 7, day: 15, minutes: 180 },
          CAIRO,
        ),
      ),
    ).toBe('2026-07-15T00:00:00.000Z');
  });

  it('is exact for UTC itself', () => {
    expect(
      iso(
        instantForLocalSlot(
          { year: 2026, month: 9, day: 3, minutes: 180 },
          'UTC',
        ),
      ),
    ).toBe('2026-09-03T03:00:00.000Z');
  });

  it('round-trips through projectToZone on an ordinary day', () => {
    const slot = { year: 2026, month: 6, day: 1, minutes: 7 * 60 + 45 };
    const at = instantForLocalSlot(slot, LONDON);
    expect(projectToZone(at, LONDON)).toEqual(slot);
  });
});

describe('instantForLocalSlot — SKIPPED local time (spring forward)', () => {
  it('London 2026-03-29 01:30 never happens, and is resolved to the transition instant', () => {
    const at = instantForLocalSlot(
      { year: 2026, month: 3, day: 29, minutes: 90 },
      LONDON,
    );
    // 01:00Z is the exact moment local jumps 01:00 -> 02:00.
    expect(iso(at)).toBe('2026-03-29T01:00:00.000Z');
    // The occurrence is NOT skipped: the local clock has passed 01:30 here...
    expect(projectToZone(at, LONDON).minutes).toBeGreaterThan(90);
    // ...and one minute earlier it had not.
    expect(
      projectToZone(new Date(at.getTime() - 60_000), LONDON).minutes,
    ).toBeLessThan(90);
  });

  it('Cairo 2026-04-24 00:30 never happens, and is resolved to the transition instant', () => {
    // Egypt starts DST at local midnight, so the SKIPPED window is the first
    // hour of the local day — a case a "transitions always happen at 01:00"
    // assumption would get wrong.
    const at = instantForLocalSlot(
      { year: 2026, month: 4, day: 24, minutes: 30 },
      CAIRO,
    );
    expect(iso(at)).toBe('2026-04-23T22:00:00.000Z');
    expect(projectToZone(at, CAIRO)).toEqual({
      year: 2026,
      month: 4,
      day: 24,
      minutes: 60,
    });
  });

  it('a daily 00:30 Cairo schedule still produces the 2026-04-24 occurrence', () => {
    // The point of resolving a skipped slot to the transition instant rather
    // than dropping it: the business day still gets its run.
    const due = dueDailySlots(new Date('2026-04-24T12:00:00Z'), CAIRO, 30, 2);
    expect(due.map((d) => d.key)).toEqual([
      '2026-04-24T00:30',
      '2026-04-23T00:30',
    ]);
    expect(iso(due[0].scheduledFor)).toBe('2026-04-23T22:00:00.000Z');
  });

  it('a slot just outside the skipped window on the same day is unaffected', () => {
    expect(
      iso(
        instantForLocalSlot(
          { year: 2026, month: 3, day: 29, minutes: 0 },
          LONDON,
        ),
      ),
    ).toBe('2026-03-29T00:00:00.000Z');
    expect(
      iso(
        instantForLocalSlot(
          { year: 2026, month: 3, day: 29, minutes: 180 },
          LONDON,
        ),
      ),
    ).toBe('2026-03-29T02:00:00.000Z');
  });
});

describe('instantForLocalSlot — REPEATED local time (fall back)', () => {
  it('London 2026-10-25 01:30 happens twice, and the EARLIER instant is chosen', () => {
    const at = instantForLocalSlot(
      { year: 2026, month: 10, day: 25, minutes: 90 },
      LONDON,
    );
    expect(iso(at)).toBe('2026-10-25T00:30:00.000Z');
    // Both instants really do render as the same local wall clock...
    expect(projectToZone(at, LONDON).minutes).toBe(90);
    expect(
      projectToZone(new Date('2026-10-25T01:30:00Z'), LONDON).minutes,
    ).toBe(90);
    // ...and the earlier one is what was returned.
    expect(at.getTime()).toBeLessThan(
      new Date('2026-10-25T01:30:00Z').getTime(),
    );
  });

  it('Cairo 2026-10-29 23:30 happens twice, and the EARLIER instant is chosen', () => {
    const at = instantForLocalSlot(
      { year: 2026, month: 10, day: 29, minutes: 23 * 60 + 30 },
      CAIRO,
    );
    expect(iso(at)).toBe('2026-10-29T20:30:00.000Z');
  });

  it('picking the earlier instant is what makes the slot ONE occurrence, not two', () => {
    // Whatever instant within the repeated hour is used to ask the question,
    // the derived occurrence KEY is identical — so the database primary key
    // collapses both to one row.
    const first = projectToZone(new Date('2026-10-25T00:30:00Z'), LONDON);
    const second = projectToZone(new Date('2026-10-25T01:30:00Z'), LONDON);
    expect(localSlotKey(first)).toBe(localSlotKey(second));
  });
});

describe('dueDailySlots — cadence + bounded catch-up', () => {
  it('returns nothing before the local time of day has been reached', () => {
    // 01:00Z on 2026-09-03 is 03:00 Cairo... so ask for 05:00 local instead.
    const due = dueDailySlots(
      new Date('2026-09-03T01:00:00Z'),
      CAIRO,
      5 * 60,
      1,
    );
    expect(due).toHaveLength(1);
    // Today's 05:00 is not due yet, so the one due slot is YESTERDAY's.
    expect(due[0].key).toBe('2026-09-02T05:00');
  });

  it("returns today's slot once the local clock has passed it", () => {
    const due = dueDailySlots(
      new Date('2026-09-03T06:00:00Z'),
      CAIRO,
      5 * 60,
      1,
    );
    expect(due.map((d) => d.key)).toEqual(['2026-09-03T05:00']);
  });

  it('is ordered most-recent-first', () => {
    const due = dueDailySlots(
      new Date('2026-09-03T06:00:00Z'),
      'UTC',
      3 * 60,
      3,
    );
    expect(due.map((d) => d.key)).toEqual([
      '2026-09-03T03:00',
      '2026-09-02T03:00',
      '2026-09-01T03:00',
    ]);
  });

  it('BOUNDS catch-up to the configured horizon — a week of downtime yields the horizon, not the week', () => {
    const due = dueDailySlots(
      new Date('2026-09-10T06:00:00Z'),
      'UTC',
      3 * 60,
      3,
    );
    expect(due).toHaveLength(3);
    expect(due[0].key).toBe('2026-09-10T03:00');
    expect(due[2].key).toBe('2026-09-08T03:00');
  });

  it('carries the resolved UTC instant alongside every slot', () => {
    const due = dueDailySlots(
      new Date('2026-09-03T06:00:00Z'),
      'UTC',
      3 * 60,
      1,
    );
    expect(iso(due[0].scheduledFor)).toBe('2026-09-03T03:00:00.000Z');
  });

  it('produces exactly one slot per local day ACROSS a fall-back, not two', () => {
    // Asked at 12:00Z on the fall-back day, with a 01:30 local slot.
    const due = dueDailySlots(new Date('2026-10-25T12:00:00Z'), LONDON, 90, 2);
    expect(due.map((d) => d.key)).toEqual([
      '2026-10-25T01:30',
      '2026-10-24T01:30',
    ]);
    expect(iso(due[0].scheduledFor)).toBe('2026-10-25T00:30:00.000Z');
  });

  it('produces the slot on a spring-forward day too, rather than skipping it', () => {
    const due = dueDailySlots(new Date('2026-03-29T12:00:00Z'), LONDON, 90, 2);
    expect(due.map((d) => d.key)).toEqual([
      '2026-03-29T01:30',
      '2026-03-28T01:30',
    ]);
    expect(iso(due[0].scheduledFor)).toBe('2026-03-29T01:00:00.000Z');
  });

  it('rejects a non-positive catch-up horizon rather than silently doing nothing', () => {
    expect(() => dueDailySlots(new Date(), 'UTC', 0, 0)).toThrow(
      ZonedTimeError,
    );
  });

  it('never consults the process timezone', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      const a = dueDailySlots(
        new Date('2026-09-03T06:00:00Z'),
        'UTC',
        3 * 60,
        2,
      );
      process.env.TZ = 'Pacific/Niue';
      const b = dueDailySlots(
        new Date('2026-09-03T06:00:00Z'),
        'UTC',
        3 * 60,
        2,
      );
      expect(a.map((s) => s.key)).toEqual(b.map((s) => s.key));
      expect(a.map((s) => iso(s.scheduledFor))).toEqual(
        b.map((s) => iso(s.scheduledFor)),
      );
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
