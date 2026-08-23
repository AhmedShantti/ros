import {
  OrderStateError,
  assertCashierMayMutateLine,
  assertMayAddLine,
  assertMayFire,
  assertOrderMutable,
  assertTransition,
  assertVersion,
  canTransition,
  isFinalised,
  isSentToProduction,
} from './order-state';

describe('state machine (SRS §7.3 #22)', () => {
  it('allows the legal transitions', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'held')).toBe(true);
    expect(canTransition('held', 'open')).toBe(true);
    expect(canTransition('open', 'cancelled')).toBe(true);
  });

  it('refuses to invent a route to completed — payment/completion do not exist', () => {
    expect(canTransition('open', 'completed')).toBe(false);
    expect(canTransition('draft', 'completed')).toBe(false);
    expect(canTransition('partially_paid', 'completed')).toBe(false);
    expect(() => assertTransition('open', 'completed')).toThrow(
      OrderStateError,
    );
  });

  it('treats finalised states as terminal', () => {
    for (const s of [
      'completed',
      'cancelled',
      'refunded',
      'partially_refunded',
    ] as const) {
      expect(canTransition(s, 'open')).toBe(false);
      expect(isFinalised(s)).toBe(true);
    }
  });

  it('does not treat working states as finalised', () => {
    for (const s of ['draft', 'open', 'held', 'parked'] as const) {
      expect(isFinalised(s)).toBe(false);
    }
  });

  it('explains the legal targets when refusing', () => {
    expect(() => assertTransition('draft', 'held')).toThrow(/Legal targets/);
    expect(() => assertTransition('completed', 'open')).toThrow(/terminal/);
  });
});

describe('BR-POS-001 — a COMPLETED order is immutable for everyone', () => {
  it('rejects any content mutation once completed', () => {
    expect(() => assertOrderMutable('completed')).toThrow(
      /no longer be modified/,
    );
    expect(() => assertOrderMutable('completed')).toThrow(/BR-POS-001/);
  });

  it('rejects adding a line to a completed order', () => {
    expect(() => assertMayAddLine('completed')).toThrow(OrderStateError);
  });

  it('rejects mutating any line of a completed order, fired or not', () => {
    expect(() => assertCashierMayMutateLine('completed', 'pending')).toThrow(
      /no longer be modified/,
    );
    expect(() => assertCashierMayMutateLine('completed', 'fired')).toThrow(
      /no longer be modified/,
    );
  });

  it('applies equally to cancelled and refunded orders', () => {
    for (const s of ['cancelled', 'refunded', 'partially_refunded'] as const) {
      expect(() => assertOrderMutable(s)).toThrow(OrderStateError);
    }
  });
});

describe('Clarification C — the fire authority boundary', () => {
  it('lets the cashier edit a line that has NOT been fired', () => {
    expect(() => assertCashierMayMutateLine('open', 'pending')).not.toThrow();
    expect(() => assertCashierMayMutateLine('draft', 'pending')).not.toThrow();
  });

  it('locks the cashier out of every sent-to-production state', () => {
    for (const s of ['fired', 'preparing', 'ready', 'served'] as const) {
      expect(isSentToProduction(s)).toBe(true);
      expect(() => assertCashierMayMutateLine('open', s)).toThrow(
        /sent to production/,
      );
    }
  });

  it('offers NO manager override — the privileged path is unimplemented', () => {
    // The function takes no actor/permission argument at all, so there is no
    // parameter that could turn the lock off.
    expect(assertCashierMayMutateLine).toHaveLength(2);
    expect(() => assertCashierMayMutateLine('open', 'fired')).toThrow(
      /no ratified permission authorises a general post-fire edit/,
    );
  });

  it('refuses to re-mutate a voided or comped line', () => {
    expect(() => assertCashierMayMutateLine('open', 'voided')).toThrow(
      /already voided/,
    );
    expect(() => assertCashierMayMutateLine('open', 'comped')).toThrow(
      /already comped/,
    );
  });
});

describe('FR-POS-003 — dine-in needs a table before FIRE, not before creation', () => {
  it('refuses to fire a dine-in order with no table', () => {
    expect(() => assertMayFire('open', 'dine_in', null)).toThrow(/FR-POS-003/);
  });

  it('fires a dine-in order that has a table', () => {
    expect(() => assertMayFire('open', 'dine_in', 'table-1')).not.toThrow();
  });

  it('does not require a table for other order types', () => {
    for (const t of [
      'takeaway',
      'delivery',
      'drive_thru',
      'pickup',
      'aggregator',
    ]) {
      expect(() => assertMayFire('open', t, null)).not.toThrow();
    }
  });

  it('never blocks CREATION of a dine-in order without a table', () => {
    // Creation-time is governed by assertMayAddLine/assertOrderMutable, neither
    // of which consults the table — the SRS says "before firing".
    expect(() => assertMayAddLine('draft')).not.toThrow();
  });
});

describe('§24.6.4 optimistic concurrency', () => {
  it('returns the next version when the expectation matches', () => {
    expect(assertVersion(3, 3)).toBe(4);
  });

  it('throws on a stale expectation', () => {
    expect(() => assertVersion(4, 3)).toThrow(/Version mismatch/);
    expect(() => assertVersion(4, 3)).toThrow(/expected 3/);
  });

  it('is not last-write-wins', () => {
    expect(() => assertVersion(1, 99)).toThrow();
  });
});
