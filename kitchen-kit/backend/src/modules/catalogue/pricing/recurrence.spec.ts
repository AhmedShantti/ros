import {
  RecurrenceError,
  isValidRecurrence,
  parseRecurrence,
  recurrenceApplies,
  recurrenceMatchesAt,
  toLocalWallClock,
} from './recurrence';

const CAIRO = 'Africa/Cairo';
const rule = (over: Record<string, unknown> = {}) => ({
  v: 1,
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  from: '15:00',
  to: '18:00',
  ...over,
});

describe('parseRecurrence — strict validation', () => {
  it('parses the FR-MNU-022 worked example', () => {
    const parsed = parseRecurrence(rule());
    expect(parsed.version).toBe(1);
    expect(parsed.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(parsed.fromMinutes).toBe(15 * 60);
    expect(parsed.toMinutes).toBe(18 * 60);
  });

  it('canonicalises order and de-duplicates days', () => {
    const parsed = parseRecurrence(rule({ days: ['fri', 'mon', 'mon'] }));
    expect(parsed.days).toEqual(['mon', 'fri']);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseRecurrence(rule({ v: 2 }))).toThrow(RecurrenceError);
    expect(() => parseRecurrence(rule({ v: undefined }))).toThrow(/version/);
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'x', 42, true]) {
      expect(() => parseRecurrence(bad)).toThrow(RecurrenceError);
    }
  });

  it('rejects invalid weekday values', () => {
    expect(() => parseRecurrence(rule({ days: ['monday'] }))).toThrow(
      /weekday/,
    );
    expect(() => parseRecurrence(rule({ days: [1] }))).toThrow(/weekday/);
    expect(() => parseRecurrence(rule({ days: 'mon' }))).toThrow(/array/);
  });

  it('rejects an empty day set (settled at implementation)', () => {
    expect(() => parseRecurrence(rule({ days: [] }))).toThrow(/at least one/);
  });

  it('rejects malformed local times', () => {
    for (const bad of ['9:00', '25:00', '15:60', '15', '', '15:00:00', 900]) {
      expect(() => parseRecurrence(rule({ from: bad }))).toThrow(
        RecurrenceError,
      );
      expect(() => parseRecurrence(rule({ to: bad }))).toThrow(RecurrenceError);
    }
  });

  it('isValidRecurrence never throws', () => {
    expect(isValidRecurrence(rule())).toBe(true);
    expect(isValidRecurrence({ nonsense: true })).toBe(false);
    expect(isValidRecurrence(null)).toBe(false);
  });
});

describe('toLocalWallClock — branch timezone projection', () => {
  it('projects an instant into the branch zone', () => {
    // 2026-08-19 is a Wednesday. 12:00 UTC = 15:00 in Cairo (UTC+3 in summer).
    const wc = toLocalWallClock(new Date('2026-08-19T12:00:00Z'), CAIRO);
    expect(wc.weekdayIndex).toBe(3); // wed
    expect(wc.minutes).toBe(15 * 60);
  });

  it('renders local midnight as 0, not 1440', () => {
    // 21:00Z = 00:00 next day in Cairo (UTC+3).
    const wc = toLocalWallClock(new Date('2026-08-19T21:00:00Z'), CAIRO);
    expect(wc.minutes).toBe(0);
    expect(wc.weekdayIndex).toBe(4); // thu
  });

  it('rejects an unknown timezone', () => {
    expect(() => toLocalWallClock(new Date(), 'Mars/Olympus')).toThrow(
      RecurrenceError,
    );
  });

  it('gives different local fields for different zones at one instant', () => {
    const at = new Date('2026-08-19T12:00:00Z');
    expect(toLocalWallClock(at, CAIRO).minutes).not.toBe(
      toLocalWallClock(at, 'Asia/Tokyo').minutes,
    );
  });
});

describe('recurrenceMatchesAt — weekday and window', () => {
  const weekdayAfternoon = parseRecurrence(rule());

  it('matches on a listed weekday inside the window', () => {
    // Wed 2026-08-19, 15:30 Cairo = 12:30Z
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-19T12:30:00Z'),
        CAIRO,
      ),
    ).toBe(true);
  });

  it('does not match on an unlisted weekday', () => {
    // Sat 2026-08-22, 15:30 Cairo
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-22T12:30:00Z'),
        CAIRO,
      ),
    ).toBe(false);
  });

  it('includes the start boundary (P0-1 half-open)', () => {
    // exactly 15:00 Cairo
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-19T12:00:00Z'),
        CAIRO,
      ),
    ).toBe(true);
  });

  it('excludes the end boundary (P0-1 half-open)', () => {
    // exactly 18:00 Cairo
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-19T15:00:00Z'),
        CAIRO,
      ),
    ).toBe(false);
    // one minute before 18:00 still matches
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-19T14:59:00Z'),
        CAIRO,
      ),
    ).toBe(true);
  });

  it('does not match before the window opens', () => {
    expect(
      recurrenceMatchesAt(
        weekdayAfternoon,
        new Date('2026-08-19T11:59:00Z'),
        CAIRO,
      ),
    ).toBe(false);
  });
});

describe('overnight windows — ADR 0008 D-04 convention (to <= from wraps)', () => {
  // Friday 22:00 → 02:00 Saturday, Cairo.
  const overnight = parseRecurrence(
    rule({ days: ['fri'], from: '22:00', to: '02:00' }),
  );

  it('matches late on the listed day', () => {
    // Fri 2026-08-21 23:00 Cairo = 20:00Z
    expect(
      recurrenceMatchesAt(overnight, new Date('2026-08-21T20:00:00Z'), CAIRO),
    ).toBe(true);
  });

  it('matches after midnight on the FOLLOWING day', () => {
    // Sat 2026-08-22 01:00 Cairo = Fri 22:00Z
    expect(
      recurrenceMatchesAt(overnight, new Date('2026-08-21T22:00:00Z'), CAIRO),
    ).toBe(true);
  });

  it('stops at the end boundary after midnight (exclusive)', () => {
    // Sat 2026-08-22 02:00 Cairo = Fri 23:00Z
    expect(
      recurrenceMatchesAt(overnight, new Date('2026-08-21T23:00:00Z'), CAIRO),
    ).toBe(false);
  });

  it('does not match in the gap before the window opens', () => {
    // Fri 2026-08-21 12:00 Cairo
    expect(
      recurrenceMatchesAt(overnight, new Date('2026-08-21T09:00:00Z'), CAIRO),
    ).toBe(false);
  });

  it('does not match the early hours of an unlisted day', () => {
    // Sun 2026-08-23 01:00 Cairo — Saturday is not listed, so nothing carries in
    expect(
      recurrenceMatchesAt(overnight, new Date('2026-08-22T22:00:00Z'), CAIRO),
    ).toBe(false);
  });

  it('from === to covers the full 24 hours from `from`', () => {
    const allDay = parseRecurrence(
      rule({ days: ['mon'], from: '09:00', to: '09:00' }),
    );
    // Mon 10:00 Cairo
    expect(
      recurrenceMatchesAt(allDay, new Date('2026-08-17T07:00:00Z'), CAIRO),
    ).toBe(true);
    // Tue 08:00 Cairo — still inside the window that opened Monday 09:00
    expect(
      recurrenceMatchesAt(allDay, new Date('2026-08-18T05:00:00Z'), CAIRO),
    ).toBe(true);
    // Tue 10:00 Cairo — window closed
    expect(
      recurrenceMatchesAt(allDay, new Date('2026-08-18T07:00:00Z'), CAIRO),
    ).toBe(false);
  });
});

describe('timezone independence and DST', () => {
  const afternoon = parseRecurrence(rule({ days: ['wed'] }));

  it('evaluates in the BRANCH zone, not the server zone', () => {
    const at = new Date('2026-08-19T12:30:00Z'); // 15:30 Cairo, 21:30 Tokyo
    expect(recurrenceMatchesAt(afternoon, at, CAIRO)).toBe(true);
    expect(recurrenceMatchesAt(afternoon, at, 'Asia/Tokyo')).toBe(false);
  });

  it('is unaffected by the process timezone', () => {
    // The result depends only on (instant, zone). Nothing here reads TZ.
    const at = new Date('2026-08-19T12:30:00Z');
    const before = recurrenceMatchesAt(afternoon, at, CAIRO);
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(recurrenceMatchesAt(afternoon, at, CAIRO)).toBe(before);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('follows wall-clock across a DST transition (Europe/London)', () => {
    // London goes UTC+0 → UTC+1 on 2026-03-29. A 15:00–18:00 local window must
    // track wall clock on BOTH sides, so the UTC instant differs by an hour.
    const london = parseRecurrence(rule({ days: ['wed', 'sun'] }));
    // Sun 2026-03-22 (GMT, UTC+0): 15:30 local = 15:30Z
    expect(
      recurrenceMatchesAt(
        london,
        new Date('2026-03-22T15:30:00Z'),
        'Europe/London',
      ),
    ).toBe(true);
    // Sun 2026-04-05 (BST, UTC+1): 15:30 local = 14:30Z
    expect(
      recurrenceMatchesAt(
        london,
        new Date('2026-04-05T14:30:00Z'),
        'Europe/London',
      ),
    ).toBe(true);
    // ...and 15:30Z on that date is 16:30 local — still inside, but 17:30Z is not.
    expect(
      recurrenceMatchesAt(
        london,
        new Date('2026-04-05T17:30:00Z'),
        'Europe/London',
      ),
    ).toBe(false);
  });

  it('handles a southern-hemisphere DST zone', () => {
    const syd = parseRecurrence(
      rule({ days: ['wed'], from: '09:00', to: '17:00' }),
    );
    // Wed 2026-08-19 10:00 Sydney (AEST, UTC+10) = 00:00Z
    expect(
      recurrenceMatchesAt(
        syd,
        new Date('2026-08-19T00:00:00Z'),
        'Australia/Sydney',
      ),
    ).toBe(true);
  });
});

describe('determinism (BR-FIN-005 / FR-OFF-050)', () => {
  it('is stable across repeated evaluation', () => {
    const parsed = parseRecurrence(rule());
    const at = new Date('2026-08-19T12:30:00Z');
    const first = recurrenceMatchesAt(parsed, at, CAIRO);
    for (let i = 0; i < 50; i++) {
      expect(recurrenceMatchesAt(parsed, at, CAIRO)).toBe(first);
    }
  });

  it('reads no ambient clock — the instant is always supplied', () => {
    const parsed = parseRecurrence(rule({ days: ['mon'] }));
    expect(
      recurrenceMatchesAt(parsed, new Date('2026-08-17T13:00:00Z'), CAIRO),
    ).toBe(true);
    expect(
      recurrenceMatchesAt(parsed, new Date('2026-08-18T13:00:00Z'), CAIRO),
    ).toBe(false);
  });

  it('recurrenceApplies parses and evaluates in one step', () => {
    expect(
      recurrenceApplies(rule(), new Date('2026-08-19T12:30:00Z'), CAIRO),
    ).toBe(true);
    expect(() => recurrenceApplies({ v: 9 }, new Date(), CAIRO)).toThrow(
      RecurrenceError,
    );
  });
});
