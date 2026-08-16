import {
  findCycle,
  nextVersionNumber,
  resolveRecipeByScope,
  ScopedRecipe,
  selectPublishedVersion,
  SubRecipeEdge,
  wouldCreateCycle,
} from './recipe-graph';

const edge = (from: string, to: string): SubRecipeEdge => ({
  fromRecipeId: from,
  toRecipeId: to,
});

describe('BR-MNU-001 / FR-MNU-042 cycle detection', () => {
  it('accepts an acyclic graph', () => {
    expect(findCycle('a', [edge('a', 'b'), edge('b', 'c')])).toBeNull();
  });

  it('rejects a direct self-reference and returns the full path', () => {
    expect(findCycle('a', [edge('a', 'a')])).toEqual(['a', 'a']);
  });

  it('rejects an indirect cycle and returns the full path', () => {
    const cycle = findCycle('a', [
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'a'),
    ]);
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
  });

  it('reports the cycle from its entry point, not from the search root', () => {
    // root -> a -> b -> c -> b : the loop is b,c,b and excludes root and a.
    const cycle = findCycle('root', [
      edge('root', 'a'),
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'b'),
    ]);
    expect(cycle).toEqual(['b', 'c', 'b']);
  });

  it('tolerates a diamond, which is shared use and not a cycle', () => {
    expect(
      findCycle('a', [
        edge('a', 'b'),
        edge('a', 'c'),
        edge('b', 'd'),
        edge('c', 'd'),
      ]),
    ).toBeNull();
  });

  it('imposes NO depth-10 limit — that limit belongs to deferred costing', () => {
    // A legal chain 40 deep must be accepted. BR-MNU-003's depth limit of 10
    // governs cost expansion (D-17-05, deferred), never cycle detection.
    const deep = Array.from({ length: 40 }, (_, i) =>
      edge(`r${i}`, `r${i + 1}`),
    );
    expect(findCycle('r0', deep)).toBeNull();

    // ...and a cycle beyond depth 10 must still be caught.
    expect(findCycle('r0', [...deep, edge('r40', 'r0')])).not.toBeNull();
  });

  it('wouldCreateCycle evaluates the prospective edge before it is saved', () => {
    const existing = [edge('b', 'a')];
    expect(wouldCreateCycle('a', 'b', existing)).toEqual(['a', 'b', 'a']);
    expect(wouldCreateCycle('a', 'c', existing)).toBeNull();
  });
});

describe('D-17-03 scope precedence — branch > brand > tenant', () => {
  const all: ScopedRecipe[] = [
    { id: 'tenant-r', scope: 'tenant', brandId: null, branchId: null },
    { id: 'brand-r', scope: 'brand', brandId: 'B1', branchId: null },
    { id: 'branch-r', scope: 'branch', brandId: null, branchId: 'BR1' },
  ];

  it('prefers the branch recipe when one matches', () => {
    expect(
      resolveRecipeByScope(all, { branchId: 'BR1', brandId: 'B1' })?.id,
    ).toBe('branch-r');
  });

  it('falls back to brand when no branch recipe matches', () => {
    expect(
      resolveRecipeByScope(all, { branchId: 'OTHER', brandId: 'B1' })?.id,
    ).toBe('brand-r');
  });

  it('falls back to tenant when neither branch nor brand matches', () => {
    expect(
      resolveRecipeByScope(all, { branchId: 'OTHER', brandId: 'OTHER' })?.id,
    ).toBe('tenant-r');
  });

  it('returns null when nothing applies', () => {
    expect(resolveRecipeByScope([], { branchId: 'BR1' })).toBeNull();
  });
});

describe('D-17-08 version selection', () => {
  it('selects the single published version', () => {
    const v = selectPublishedVersion([
      { id: 'v1', version: 1, status: 'superseded' as const },
      { id: 'v2', version: 2, status: 'published' as const },
      { id: 'v3', version: 3, status: 'draft' as const },
    ]);
    expect(v?.id).toBe('v2');
  });

  it('returns null when nothing is published — never falls back', () => {
    expect(
      selectPublishedVersion([
        { id: 'v1', version: 1, status: 'superseded' as const },
        { id: 'v2', version: 2, status: 'draft' as const },
      ]),
    ).toBeNull();
  });

  it('ignores version ordering: status alone decides', () => {
    // The published row is the LOWEST version number here. If any ordering or
    // recency rule had crept in, this would pick v9.
    const v = selectPublishedVersion([
      { id: 'v9', version: 9, status: 'draft' as const },
      { id: 'v1', version: 1, status: 'published' as const },
    ]);
    expect(v?.id).toBe('v1');
  });

  it('takes no effective-date argument at all (D-17-08 Q2, by construction)', () => {
    // selectPublishedVersion has arity 1. An effective date cannot reach it,
    // so `effective_from` provably cannot influence selection.
    expect(selectPublishedVersion).toHaveLength(1);
    expect(resolveRecipeByScope).toHaveLength(2);
  });
});

describe('version numbering', () => {
  it('starts at 1', () => {
    expect(nextVersionNumber([])).toBe(1);
  });

  it('is max + 1, not count + 1', () => {
    expect(nextVersionNumber([{ version: 1 }, { version: 7 }])).toBe(8);
  });
});
