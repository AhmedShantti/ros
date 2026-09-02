import {
  AssignmentScope,
  ResolvedTargetScope,
  buildPermittedBranchSet,
  coversTarget,
  permittedBranchSetUnits,
  renderScope,
} from './scope';

const BRAND_X = '11111111-1111-1111-1111-111111111111';
const BRAND_Y = '22222222-2222-2222-2222-222222222222';
const BRANCH_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRANCH_Y = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const tenantScope: AssignmentScope = { type: 'tenant' };
const brandX: AssignmentScope = { type: 'brand', brandId: BRAND_X };
const branchX: AssignmentScope = { type: 'branch', branchId: BRANCH_X };

const tenantTarget: ResolvedTargetScope = { type: 'tenant' };
const brandTargetX: ResolvedTargetScope = { type: 'brand', brandId: BRAND_X };
const brandTargetY: ResolvedTargetScope = { type: 'brand', brandId: BRAND_Y };
/** A branch of brand X. */
const branchTargetX: ResolvedTargetScope = {
  type: 'branch',
  branchId: BRANCH_X,
  brandId: BRAND_X,
};
/** A branch of brand Y. */
const branchTargetY: ResolvedTargetScope = {
  type: 'branch',
  branchId: BRANCH_Y,
  brandId: BRAND_Y,
};

describe('scope lattice (FR-SEC-002/003/004)', () => {
  describe('TENANT assignment covers downward to everything', () => {
    it('covers a TENANT target', () => {
      expect(coversTarget(tenantScope, tenantTarget)).toBe(true);
    });
    it('covers a BRAND target', () => {
      expect(coversTarget(tenantScope, brandTargetX)).toBe(true);
      expect(coversTarget(tenantScope, brandTargetY)).toBe(true);
    });
    it('covers a BRANCH target', () => {
      expect(coversTarget(tenantScope, branchTargetX)).toBe(true);
      expect(coversTarget(tenantScope, branchTargetY)).toBe(true);
    });
  });

  describe('BRAND X assignment', () => {
    it('covers BRAND X', () => {
      expect(coversTarget(brandX, brandTargetX)).toBe(true);
    });
    it('covers a BRANCH whose parent brand is X', () => {
      expect(coversTarget(brandX, branchTargetX)).toBe(true);
    });
    it('does NOT cover the TENANT target (never upward)', () => {
      expect(coversTarget(brandX, tenantTarget)).toBe(false);
    });
    it('does NOT cover BRAND Y (never sideways)', () => {
      expect(coversTarget(brandX, brandTargetY)).toBe(false);
    });
    it('does NOT cover a branch of BRAND Y', () => {
      expect(coversTarget(brandX, branchTargetY)).toBe(false);
    });
    it('does NOT cover a branch whose parent brand is UNKNOWN (fails closed)', () => {
      expect(
        coversTarget(brandX, {
          type: 'branch',
          branchId: BRANCH_X,
          brandId: null,
        }),
      ).toBe(false);
    });
  });

  describe('BRANCH X assignment', () => {
    it('covers BRANCH X only', () => {
      expect(coversTarget(branchX, branchTargetX)).toBe(true);
    });
    it('does NOT cover the TENANT target', () => {
      expect(coversTarget(branchX, tenantTarget)).toBe(false);
    });
    it('does NOT cover a BRAND target — not even its own parent brand', () => {
      expect(coversTarget(branchX, brandTargetX)).toBe(false);
    });
    it('does NOT cover BRANCH Y', () => {
      expect(coversTarget(branchX, branchTargetY)).toBe(false);
    });
  });
});

describe('permitted-branch set is SYMBOLIC and bounded', () => {
  it('renders a tenant-wide actor as ONE unit, independent of branch count', () => {
    const set = buildPermittedBranchSet([tenantScope]);
    expect(set).toEqual({ v: 1, all: true, brands: [], branches: [] });
    expect(permittedBranchSetUnits(set)).toBe(1);
  });

  it('renders brand scopes symbolically, never expanded to branches', () => {
    const set = buildPermittedBranchSet([
      { type: 'brand', brandId: BRAND_Y },
      { type: 'brand', brandId: BRAND_X },
    ]);
    expect(set.all).toBe(false);
    // Sorted, so the same authority always renders identically.
    expect(set.brands).toEqual([BRAND_X, BRAND_Y].sort());
    expect(set.branches).toEqual([]);
    expect(permittedBranchSetUnits(set)).toBe(2);
  });

  it('lists explicit branch scopes, deduplicated and sorted', () => {
    const set = buildPermittedBranchSet([
      { type: 'branch', branchId: BRANCH_Y },
      { type: 'branch', branchId: BRANCH_X },
      { type: 'branch', branchId: BRANCH_X },
    ]);
    expect(set.branches).toEqual([BRANCH_X, BRANCH_Y].sort());
    expect(permittedBranchSetUnits(set)).toBe(2);
  });

  it('ZERO assignments is an EMPTY set, never an unrestricted one (R-8)', () => {
    const set = buildPermittedBranchSet([]);
    expect(set).toEqual({ v: 1, all: false, brands: [], branches: [] });
    expect(permittedBranchSetUnits(set)).toBe(0);
  });

  it('renders scopes compactly and stably', () => {
    expect(renderScope(tenantScope)).toBe('tenant');
    expect(renderScope(brandX)).toBe(`brand:${BRAND_X}`);
    expect(renderScope(branchX)).toBe(`branch:${BRANCH_X}`);
  });
});
