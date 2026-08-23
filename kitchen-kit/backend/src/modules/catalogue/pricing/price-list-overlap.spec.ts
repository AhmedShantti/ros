import {
  OverlapKey,
  findConflicting,
  isExclusionViolation,
  sameInvariantSlot,
  violatesOverlapInvariant,
  windowsOverlap,
} from './price-list-overlap';

const TENANT = '11111111-1111-1111-1111-111111111111';
const BRANCH_X = 'aaaaaaaa-0000-0000-0000-00000000000x'.replace('x', '1');
const BRANCH_Y = 'aaaaaaaa-0000-0000-0000-00000000000x'.replace('x', '2');
const BRAND_A = 'bbbbbbbb-0000-0000-0000-000000000001';
const BRAND_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const d = (iso: string): Date => new Date(iso);

const key = (over: Partial<OverlapKey> = {}): OverlapKey => ({
  scopeType: 'tenant',
  scopeId: TENANT,
  priority: 0,
  validFrom: null,
  validTo: null,
  ...over,
});

describe('windowsOverlap — half-open [from, to) with null as unbounded', () => {
  it('two fully unbounded windows overlap', () => {
    expect(windowsOverlap(key(), key())).toBe(true);
  });

  it('overlapping bounded windows overlap', () => {
    expect(
      windowsOverlap(
        { validFrom: d('2027-01-01'), validTo: d('2027-03-01') },
        { validFrom: d('2027-02-01'), validTo: d('2027-04-01') },
      ),
    ).toBe(true);
  });

  it('adjacent windows that merely touch do NOT overlap', () => {
    expect(
      windowsOverlap(
        { validFrom: d('2027-01-01'), validTo: d('2027-02-01') },
        { validFrom: d('2027-02-01'), validTo: d('2027-03-01') },
      ),
    ).toBe(false);
  });

  it('disjoint windows do not overlap', () => {
    expect(
      windowsOverlap(
        { validFrom: d('2027-01-01'), validTo: d('2027-02-01') },
        { validFrom: d('2027-06-01'), validTo: d('2027-07-01') },
      ),
    ).toBe(false);
  });

  it('an unbounded start overlaps anything that starts later', () => {
    expect(
      windowsOverlap(
        { validFrom: null, validTo: d('2027-02-01') },
        { validFrom: d('2027-01-01'), validTo: null },
      ),
    ).toBe(true);
  });

  it('an unbounded start does not reach a window that begins after its end', () => {
    expect(
      windowsOverlap(
        { validFrom: null, validTo: d('2027-01-01') },
        { validFrom: d('2027-02-01'), validTo: null },
      ),
    ).toBe(false);
  });

  it('a window fully contained in another overlaps', () => {
    expect(
      windowsOverlap(
        { validFrom: d('2027-01-01'), validTo: d('2027-12-01') },
        { validFrom: d('2027-03-01'), validTo: d('2027-04-01') },
      ),
    ).toBe(true);
  });

  it('is symmetric', () => {
    const a = { validFrom: d('2027-01-01'), validTo: d('2027-03-01') };
    const b = { validFrom: d('2027-02-01'), validTo: d('2027-04-01') };
    expect(windowsOverlap(a, b)).toBe(windowsOverlap(b, a));
  });
});

describe('sameInvariantSlot — scope means the actual target, not just the kind', () => {
  it('two tenant-scope lists share a slot', () => {
    expect(sameInvariantSlot(key(), key())).toBe(true);
  });

  it('the SAME branch shares a slot', () => {
    const a = key({ scopeType: 'branch', scopeId: BRANCH_X });
    expect(sameInvariantSlot(a, { ...a })).toBe(true);
  });

  it('DIFFERENT branches do not share a slot, though both are `branch`', () => {
    expect(
      sameInvariantSlot(
        key({ scopeType: 'branch', scopeId: BRANCH_X }),
        key({ scopeType: 'branch', scopeId: BRANCH_Y }),
      ),
    ).toBe(false);
  });

  it('DIFFERENT brands do not share a slot', () => {
    expect(
      sameInvariantSlot(
        key({ scopeType: 'brand', scopeId: BRAND_A }),
        key({ scopeType: 'brand', scopeId: BRAND_B }),
      ),
    ).toBe(false);
  });

  it('different scope kinds do not share a slot', () => {
    expect(
      sameInvariantSlot(
        key({ scopeType: 'branch', scopeId: BRANCH_X }),
        key({ scopeType: 'brand', scopeId: BRANCH_X }),
      ),
    ).toBe(false);
  });

  it('different priorities do not share a slot', () => {
    expect(sameInvariantSlot(key({ priority: 0 }), key({ priority: 1 }))).toBe(
      false,
    );
  });

  it('treats a null scopeId and the nil-uuid sentinel as the same scope', () => {
    expect(
      sameInvariantSlot(
        key({ scopeId: null }),
        key({ scopeId: '00000000-0000-0000-0000-000000000000' }),
      ),
    ).toBe(true);
  });
});

describe('violatesOverlapInvariant — SRS §7.3 #10', () => {
  it('REJECTS same tenant scope + same priority + overlapping windows', () => {
    expect(violatesOverlapInvariant(key(), key())).toBe(true);
  });

  it('REJECTS same branch + same priority + overlapping windows', () => {
    const a = key({ scopeType: 'branch', scopeId: BRANCH_X });
    expect(violatesOverlapInvariant(a, { ...a })).toBe(true);
  });

  it('REJECTS same brand + same priority + overlapping windows', () => {
    const a = key({ scopeType: 'brand', scopeId: BRAND_A });
    expect(violatesOverlapInvariant(a, { ...a })).toBe(true);
  });

  it('ALLOWS same scope with different priority', () => {
    expect(
      violatesOverlapInvariant(key({ priority: 0 }), key({ priority: 1 })),
    ).toBe(false);
  });

  it('ALLOWS different branches with the same priority and overlapping dates', () => {
    expect(
      violatesOverlapInvariant(
        key({ scopeType: 'branch', scopeId: BRANCH_X }),
        key({ scopeType: 'branch', scopeId: BRANCH_Y }),
      ),
    ).toBe(false);
  });

  it('ALLOWS different brands with the same priority and overlapping dates', () => {
    expect(
      violatesOverlapInvariant(
        key({ scopeType: 'brand', scopeId: BRAND_A }),
        key({ scopeType: 'brand', scopeId: BRAND_B }),
      ),
    ).toBe(false);
  });

  it('ALLOWS same scope and priority with non-overlapping windows', () => {
    expect(
      violatesOverlapInvariant(
        key({ validFrom: d('2027-01-01'), validTo: d('2027-02-01') }),
        key({ validFrom: d('2027-02-01'), validTo: d('2027-03-01') }),
      ),
    ).toBe(false);
  });

  it('REJECTS two order-type lists sharing scope, priority and window', () => {
    // FR-MNU-020 does not count order type as scope, so §7.3 #10 applies to them
    // exactly as to any other pair. FR-MNU-021 stays satisfiable via distinct
    // priorities — it nowhere requires order-type lists to share a priority.
    expect(violatesOverlapInvariant(key(), key())).toBe(true);
  });

  it('ALLOWS two order-type lists at DIFFERENT priorities', () => {
    expect(
      violatesOverlapInvariant(key({ priority: 0 }), key({ priority: 1 })),
    ).toBe(false);
  });
});

describe('findConflicting', () => {
  it('returns the conflicting list', () => {
    const existing = [
      { ...key({ priority: 1 }), id: 'a', name: 'A' },
      { ...key({ priority: 0 }), id: 'b', name: 'B' },
    ];
    expect(findConflicting(key({ priority: 0 }), existing)?.name).toBe('B');
  });

  it('returns null when nothing conflicts', () => {
    const existing = [{ ...key({ priority: 1 }), id: 'a', name: 'A' }];
    expect(findConflicting(key({ priority: 0 }), existing)).toBeNull();
  });

  it('returns null against an empty set', () => {
    expect(findConflicting(key(), [])).toBeNull();
  });
});

describe('isExclusionViolation', () => {
  it('detects the SQLSTATE on the error object', () => {
    expect(isExclusionViolation({ code: '23P01' })).toBe(true);
  });

  it('detects it in the message', () => {
    expect(
      isExclusionViolation(
        new Error('conflicting key value violates exclusion constraint 23P01'),
      ),
    ).toBe(true);
  });

  it('detects the constraint by name', () => {
    expect(
      isExclusionViolation(new Error('violates ex_price_list_no_overlap')),
    ).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isExclusionViolation(new Error('boom'))).toBe(false);
    expect(isExclusionViolation({ code: 'P2002' })).toBe(false);
    expect(isExclusionViolation(null)).toBe(false);
    expect(isExclusionViolation(undefined)).toBe(false);
    expect(isExclusionViolation('23P01')).toBe(false);
  });
});
