import { PriceCandidate, PriceContext, resolvePrice } from './price-resolution';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRANCH = '22222222-2222-2222-2222-222222222222';
const OTHER_BRANCH = '33333333-3333-3333-3333-333333333333';
const VARIANT = '44444444-4444-4444-4444-444444444444';

const AT = new Date('2026-08-19T12:00:00.000Z');

const ctx = (over: Partial<PriceContext> = {}): PriceContext => ({
  brandId: BRAND,
  branchId: BRANCH,
  branchTimezone: 'Africa/Cairo',
  menuItemVariantId: VARIANT,
  orderType: 'dine_in',
  at: AT,
  ...over,
});

let seq = 0;
const candidate = (over: Partial<PriceCandidate> = {}): PriceCandidate => {
  seq += 1;
  return {
    priceListId: `pl-${seq}`,
    priceListName: `list-${seq}`,
    scopeType: 'tenant',
    scopeId: null,
    orderType: null,
    validFrom: null,
    validTo: null,
    recurrenceRule: null,
    priority: 0,
    status: 'active',
    entryId: `pe-${seq}`,
    priceMinorUnits: 1000n,
    currency: 'EGP',
    ...over,
  };
};

describe('scope precedence — branch > brand > tenant (FR-POS-040 tiers 5/6)', () => {
  const tenantList = candidate({ scopeType: 'tenant', priceMinorUnits: 1000n });
  const brandList = candidate({
    scopeType: 'brand',
    scopeId: BRAND,
    priceMinorUnits: 900n,
  });
  const branchList = candidate({
    scopeType: 'branch',
    scopeId: BRANCH,
    priceMinorUnits: 800n,
  });

  it('falls back to the tenant list when nothing more specific applies', () => {
    const r = resolvePrice([tenantList], ctx());
    expect(r.resolved?.amount.amount).toBe(1000n);
    expect(r.resolved?.scopeType).toBe('tenant');
  });

  it('prefers brand over tenant', () => {
    const r = resolvePrice([tenantList, brandList], ctx());
    expect(r.resolved?.amount.amount).toBe(900n);
    expect(r.resolved?.scopeType).toBe('brand');
  });

  it('prefers branch over brand and tenant', () => {
    const r = resolvePrice([tenantList, brandList, branchList], ctx());
    expect(r.resolved?.amount.amount).toBe(800n);
    expect(r.resolved?.scopeType).toBe('branch');
  });

  it('ignores a branch list targeting a different branch', () => {
    const other = candidate({
      scopeType: 'branch',
      scopeId: OTHER_BRANCH,
      priceMinorUnits: 100n,
    });
    const r = resolvePrice([tenantList, other], ctx());
    expect(r.resolved?.scopeType).toBe('tenant');
  });

  it('ignores a brand list targeting a different brand', () => {
    const other = candidate({
      scopeType: 'brand',
      scopeId: 'not-this-brand',
      priceMinorUnits: 100n,
    });
    const r = resolvePrice([tenantList, other], ctx());
    expect(r.resolved?.scopeType).toBe('tenant');
  });
});

describe('order-type resolution (FR-MNU-021, FR-POS-040 tier 4)', () => {
  it('prefers an order-type-specific list over an all-types list', () => {
    const all = candidate({ orderType: null, priceMinorUnits: 1000n });
    const delivery = candidate({
      orderType: 'delivery',
      priceMinorUnits: 1200n,
    });
    const r = resolvePrice([all, delivery], ctx({ orderType: 'delivery' }));
    expect(r.resolved?.amount.amount).toBe(1200n);
    expect(r.resolved?.orderType).toBe('delivery');
  });

  it('ignores a list for a different order type', () => {
    const all = candidate({ orderType: null, priceMinorUnits: 1000n });
    const delivery = candidate({
      orderType: 'delivery',
      priceMinorUnits: 1200n,
    });
    const r = resolvePrice([all, delivery], ctx({ orderType: 'dine_in' }));
    expect(r.resolved?.amount.amount).toBe(1000n);
  });

  it('order-type specificity outranks scope, per FR-POS-040 tier order', () => {
    // Tier 4 (order-type) sits above tier 5 (branch) in FR-POS-040's own list.
    const branchAll = candidate({
      scopeType: 'branch',
      scopeId: BRANCH,
      orderType: null,
      priceMinorUnits: 800n,
    });
    const tenantDelivery = candidate({
      scopeType: 'tenant',
      orderType: 'delivery',
      priceMinorUnits: 1500n,
    });
    const r = resolvePrice(
      [branchAll, tenantDelivery],
      ctx({ orderType: 'delivery' }),
    );
    expect(r.resolved?.amount.amount).toBe(1500n);
    expect(r.resolved?.orderType).toBe('delivery');
  });

  it('matches an all-types list when the context has no order type', () => {
    const all = candidate({ orderType: null });
    const r = resolvePrice([all], ctx({ orderType: null }));
    expect(r.resolved).not.toBeNull();
  });
});

describe('validity windows (FR-MNU-020, FR-MNU-023)', () => {
  const past = new Date('2026-01-01T00:00:00.000Z');
  const future = new Date('2027-01-01T00:00:00.000Z');

  it('accepts a list whose window is open at both ends', () => {
    const r = resolvePrice([candidate()], ctx());
    expect(r.resolved).not.toBeNull();
  });

  it('accepts a currently-active bounded window', () => {
    const c = candidate({ validFrom: past, validTo: future });
    expect(resolvePrice([c], ctx()).resolved).not.toBeNull();
  });

  it('ignores an expired window', () => {
    const c = candidate({ validFrom: past, validTo: past });
    expect(resolvePrice([c], ctx()).resolved).toBeNull();
  });

  it('does not activate a future price early (FR-MNU-023)', () => {
    const c = candidate({ validFrom: future });
    expect(resolvePrice([c], ctx()).resolved).toBeNull();
  });

  it('activates a future price exactly at its effective instant (FR-MNU-023)', () => {
    const effective = new Date('2026-09-01T00:00:00.000Z');
    const c = candidate({ validFrom: effective, priceMinorUnits: 1500n });
    const before = new Date(effective.getTime() - 1);
    expect(resolvePrice([c], ctx({ at: before })).resolved).toBeNull();
    expect(
      resolvePrice([c], ctx({ at: effective })).resolved?.amount.amount,
    ).toBe(1500n);
  });

  it('treats the window end as exclusive (documented local choice)', () => {
    const end = new Date('2026-09-01T00:00:00.000Z');
    const c = candidate({ validTo: end });
    const justBefore = new Date(end.getTime() - 1);
    expect(resolvePrice([c], ctx({ at: justBefore })).resolved).not.toBeNull();
    expect(resolvePrice([c], ctx({ at: end })).resolved).toBeNull();
  });

  it('a scheduled future list supersedes the standing one once it starts', () => {
    const standing = candidate({ priceMinorUnits: 1000n, priority: 0 });
    const scheduled = candidate({
      priceMinorUnits: 1200n,
      priority: 1,
      validFrom: new Date('2026-09-01T00:00:00.000Z'),
    });
    const beforeChange = ctx({ at: new Date('2026-08-31T23:59:59.999Z') });
    const afterChange = ctx({ at: new Date('2026-09-01T00:00:01.000Z') });
    expect(
      resolvePrice([standing, scheduled], beforeChange).resolved?.amount.amount,
    ).toBe(1000n);
    expect(
      resolvePrice([standing, scheduled], afterChange).resolved?.amount.amount,
    ).toBe(1200n);
  });

  it('ignores an operator-expired list regardless of its window', () => {
    const c = candidate({ status: 'expired' });
    expect(resolvePrice([c], ctx()).resolved).toBeNull();
  });

  it('accepts a scheduled-status list whose window is open', () => {
    const c = candidate({ status: 'scheduled' });
    expect(resolvePrice([c], ctx()).resolved).not.toBeNull();
  });
});

describe('explicit priority (FR-MNU-020)', () => {
  it('higher priority wins within the same scope and order type', () => {
    const low = candidate({ priority: 1, priceMinorUnits: 1000n });
    const high = candidate({ priority: 5, priceMinorUnits: 700n });
    const r = resolvePrice([low, high], ctx());
    expect(r.resolved?.amount.amount).toBe(700n);
    expect(r.resolved?.priority).toBe(5);
  });

  it('P0-4: priority does not override tier or scope specificity', () => {
    const tenantHigh = candidate({
      scopeType: 'tenant',
      priority: 99,
      priceMinorUnits: 100n,
    });
    const branchLow = candidate({
      scopeType: 'branch',
      scopeId: BRANCH,
      priority: 0,
      priceMinorUnits: 800n,
    });
    const r = resolvePrice([tenantHigh, branchLow], ctx());
    expect(r.resolved?.scopeType).toBe('branch');
  });
});

describe('ambiguity is reported, never invented away', () => {
  it('reports a tie on every source-defined discriminator', () => {
    const a = candidate({
      priceListName: 'A',
      priority: 3,
      priceMinorUnits: 1000n,
    });
    const b = candidate({
      priceListName: 'B',
      priority: 3,
      priceMinorUnits: 2000n,
    });
    const r = resolvePrice([a, b], ctx());
    expect(r.ambiguous).toBe(true);
    expect(r.resolved).toBeNull();
    expect(r.warning).toContain('equal precedence');
    expect(r.warning).toContain('A');
    expect(r.warning).toContain('B');
  });

  it('does not fall back to array, id or insertion order', () => {
    const a = candidate({ priceListName: 'A', priceMinorUnits: 1000n });
    const b = candidate({ priceListName: 'B', priceMinorUnits: 2000n });
    expect(resolvePrice([a, b], ctx()).resolved).toBeNull();
    expect(resolvePrice([b, a], ctx()).resolved).toBeNull();
  });

  it('is not ambiguous when a discriminator separates the candidates', () => {
    const a = candidate({ priority: 3 });
    const b = candidate({ priority: 4 });
    expect(resolvePrice([a, b], ctx()).ambiguous).toBe(false);
  });
});

describe('P0-2 recurrence drives FR-POS-040 Tier 3', () => {
  const happyHour = {
    v: 1,
    days: ['wed'],
    from: '15:00',
    to: '18:00',
  };
  // Wed 2026-08-19 15:30 Cairo = 12:30Z ; 19:00 Cairo = 16:00Z
  const inside = new Date('2026-08-19T12:30:00Z');
  const outside = new Date('2026-08-19T16:00:00Z');

  it('a matching recurring list wins as Tier 3', () => {
    const recurring = candidate({
      priceListName: 'happy-hour',
      recurrenceRule: happyHour,
      priceMinorUnits: 500n,
    });
    const standing = candidate({ priceMinorUnits: 1000n });
    const r = resolvePrice([recurring, standing], ctx({ at: inside }));
    expect(r.resolved?.amount.amount).toBe(500n);
    expect(r.resolved?.tier).toBe(3);
    expect(r.resolved?.tierLabel).toBe('time_based');
    expect(r.resolved?.recurring).toBe(true);
    expect(r.resolved?.rule).toContain('recurrence=v1-match');
  });

  it('a non-matching recurring list is simply not eligible', () => {
    const recurring = candidate({
      recurrenceRule: happyHour,
      priceMinorUnits: 500n,
    });
    const standing = candidate({ priceMinorUnits: 1000n });
    const r = resolvePrice([recurring, standing], ctx({ at: outside }));
    expect(r.resolved?.amount.amount).toBe(1000n);
    expect(r.resolved?.recurring).toBe(false);
    expect(r.undeterminable).toHaveLength(0);
  });

  it('Tier 3 beats an order-type Tier 4 list', () => {
    const recurring = candidate({
      recurrenceRule: happyHour,
      priceMinorUnits: 500n,
    });
    const orderTyped = candidate({
      orderType: 'delivery',
      priceMinorUnits: 900n,
    });
    const r = resolvePrice(
      [orderTyped, recurring],
      ctx({ at: inside, orderType: 'delivery' }),
    );
    expect(r.resolved?.tier).toBe(3);
    expect(r.resolved?.amount.amount).toBe(500n);
  });

  it('a recurring list with an order type must still match that order type', () => {
    const recurring = candidate({
      recurrenceRule: happyHour,
      orderType: 'delivery',
      priceMinorUnits: 500n,
    });
    const standing = candidate({ priceMinorUnits: 1000n });
    // dine_in context: the recurring delivery list is ineligible despite matching time
    const r = resolvePrice(
      [recurring, standing],
      ctx({ at: inside, orderType: 'dine_in' }),
    );
    expect(r.resolved?.amount.amount).toBe(1000n);
  });

  it('the outer validity window still gates a recurring list', () => {
    const recurring = candidate({
      recurrenceRule: happyHour,
      priceMinorUnits: 500n,
      validFrom: new Date('2027-01-01T00:00:00.000Z'),
    });
    const standing = candidate({ priceMinorUnits: 1000n });
    const r = resolvePrice([recurring, standing], ctx({ at: inside }));
    expect(r.resolved?.amount.amount).toBe(1000n);
  });

  it('a malformed recurrence rule is reported, never guessed', () => {
    const broken = candidate({
      priceListName: 'broken',
      recurrenceRule: { v: 9, nonsense: true },
      priceMinorUnits: 1n,
    });
    const standing = candidate({ priceMinorUnits: 1000n });
    const r = resolvePrice([broken, standing], ctx({ at: inside }));
    expect(r.resolved?.amount.amount).toBe(1000n);
    expect(r.undeterminable).toHaveLength(1);
    expect(r.undeterminable[0].reason).toBe('recurrence_rule_malformed');
    expect(r.warning).toContain('malformed recurrence');
  });

  it('treats undefined and null recurrence alike as "no recurrence"', () => {
    expect(
      resolvePrice([candidate({ recurrenceRule: undefined })], ctx())
        .undeterminable,
    ).toHaveLength(0);
  });
});

describe('FR-POS-040 tiers 4-7 and the P0-5 base fallback', () => {
  it('Tier 4 order-type beats Tier 5 branch', () => {
    const branchList = candidate({
      scopeType: 'branch',
      scopeId: BRANCH,
      priceMinorUnits: 800n,
    });
    const orderTyped = candidate({
      orderType: 'delivery',
      priceMinorUnits: 1500n,
    });
    const r = resolvePrice(
      [branchList, orderTyped],
      ctx({ orderType: 'delivery' }),
    );
    expect(r.resolved?.tier).toBe(4);
    expect(r.resolved?.amount.amount).toBe(1500n);
  });

  it('Tier 5 branch beats Tier 6 brand', () => {
    const brandList = candidate({
      scopeType: 'brand',
      scopeId: BRAND,
      priceMinorUnits: 900n,
    });
    const branchList = candidate({
      scopeType: 'branch',
      scopeId: BRANCH,
      priceMinorUnits: 800n,
    });
    const r = resolvePrice([brandList, branchList], ctx());
    expect(r.resolved?.tier).toBe(5);
    expect(r.resolved?.amount.amount).toBe(800n);
  });

  it('Tier 6 brand beats the Tier 7 tenant base', () => {
    const tenantBase = candidate({
      scopeType: 'tenant',
      priceMinorUnits: 1000n,
    });
    const brandList = candidate({
      scopeType: 'brand',
      scopeId: BRAND,
      priceMinorUnits: 900n,
    });
    const r = resolvePrice([tenantBase, brandList], ctx());
    expect(r.resolved?.tier).toBe(6);
    expect(r.resolved?.amount.amount).toBe(900n);
  });

  it('P0-5: the tenant-scoped non-order-specific list IS the base tier', () => {
    const tenantBase = candidate({
      scopeType: 'tenant',
      orderType: null,
      priceMinorUnits: 1000n,
    });
    const r = resolvePrice([tenantBase], ctx());
    expect(r.resolved?.tier).toBe(7);
    expect(r.resolved?.tierLabel).toBe('base_tenant');
    expect(r.resolved?.amount.amount).toBe(1000n);
  });

  it('a tenant list WITH an order type is Tier 4, not the base tier', () => {
    const tenantDelivery = candidate({
      scopeType: 'tenant',
      orderType: 'delivery',
      priceMinorUnits: 1200n,
    });
    const r = resolvePrice([tenantDelivery], ctx({ orderType: 'delivery' }));
    expect(r.resolved?.tier).toBe(4);
  });
});

describe('no eligible price', () => {
  it('returns null without a warning when simply nothing applies', () => {
    const r = resolvePrice([], ctx());
    expect(r.resolved).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.undeterminable).toHaveLength(0);
    expect(r.warning).toBeUndefined();
  });
});

describe('provenance for a future Sales snapshot (FR-POS-042 support)', () => {
  it('returns the list, entry, scope, order type, priority and rule', () => {
    const c = candidate({
      priceListId: 'pl-x',
      priceListName: 'Ramadan Delivery',
      entryId: 'pe-x',
      scopeType: 'branch',
      scopeId: BRANCH,
      orderType: 'delivery',
      priority: 7,
      priceMinorUnits: 2500n,
      currency: 'EGP',
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
    const r = resolvePrice([c], ctx({ orderType: 'delivery' }));

    expect(r.resolved).toMatchObject({
      priceListId: 'pl-x',
      priceListName: 'Ramadan Delivery',
      priceEntryId: 'pe-x',
      scopeType: 'branch',
      orderType: 'delivery',
      priority: 7,
    });
    expect(r.resolved?.rule).toContain('scope=branch');
    expect(r.resolved?.rule).toContain('orderType=delivery');
    expect(r.resolved?.rule).toContain('priority=7');
    expect(r.resolved?.amount.toString()).toBe('25.00 EGP');
    expect(r.evaluatedAt).toEqual(AT);
    expect(r.evaluatedInTimezone).toBe('Africa/Cairo');
  });

  it('carries the entry currency into the Money, honouring its exponent', () => {
    const kwd = candidate({ priceMinorUnits: 1250n, currency: 'KWD' });
    const r = resolvePrice([kwd], ctx());
    expect(r.resolved?.amount.currency.exponent).toBe(3);
    expect(r.resolved?.amount.toDecimalString()).toBe('1.250');
  });
});

describe('determinism (ADR-004 / BR-FIN-005 / FR-OFF-050)', () => {
  const set = [
    candidate({ scopeType: 'tenant', priceMinorUnits: 1000n }),
    candidate({ scopeType: 'brand', scopeId: BRAND, priceMinorUnits: 900n }),
    candidate({
      scopeType: 'branch',
      scopeId: BRANCH,
      orderType: 'delivery',
      priceMinorUnits: 1300n,
    }),
  ];

  it('is stable across repeated execution', () => {
    const first = resolvePrice(set, ctx({ orderType: 'delivery' }));
    for (let i = 0; i < 25; i++) {
      const again = resolvePrice(set, ctx({ orderType: 'delivery' }));
      expect(again.resolved?.priceEntryId).toBe(first.resolved?.priceEntryId);
      expect(again.resolved?.amount.amount).toBe(first.resolved?.amount.amount);
    }
  });

  it('is independent of candidate input order', () => {
    const forward = resolvePrice(set, ctx({ orderType: 'delivery' }));
    const reversed = resolvePrice(
      [...set].reverse(),
      ctx({ orderType: 'delivery' }),
    );
    expect(reversed.resolved?.priceEntryId).toBe(
      forward.resolved?.priceEntryId,
    );
  });

  it('reads no ambient clock — the instant is always supplied', () => {
    const c = candidate({ validFrom: new Date('2030-01-01T00:00:00.000Z') });
    // Evaluated "in 2031" it applies; evaluated now it does not. Same inputs,
    // same answer, every time — nothing consults Date.now().
    expect(
      resolvePrice([c], ctx({ at: new Date('2031-01-01T00:00:00.000Z') }))
        .resolved,
    ).not.toBeNull();
    expect(resolvePrice([c], ctx()).resolved).toBeNull();
  });
});
