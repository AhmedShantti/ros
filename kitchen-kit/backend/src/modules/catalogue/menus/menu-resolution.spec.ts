/**
 * FR-MNU-003 resolution semantics, exercised as a pure function over the same
 * shape `MenusService.resolveForBranch` produces: active menus ordered by
 * descending priority, with an ambiguity flag when two share a priority.
 */
interface M {
  id: string;
  priority: number;
  isActive: boolean;
}

function resolve(menus: M[]): { order: string[]; ambiguous: boolean } {
  const active = menus
    .filter((m) => m.isActive)
    .sort((a, b) => b.priority - a.priority);
  const ambiguous = active.some(
    (m, i) => i > 0 && m.priority === active[i - 1].priority,
  );
  return { order: active.map((m) => m.id), ambiguous };
}

describe('menu resolution (FR-MNU-003)', () => {
  it('orders by explicit priority, highest first', () => {
    const r = resolve([
      { id: 'main', priority: 0, isActive: true },
      { id: 'ramadan', priority: 10, isActive: true },
      { id: 'late', priority: 5, isActive: true },
    ]);
    expect(r.order).toEqual(['ramadan', 'late', 'main']);
    expect(r.ambiguous).toBe(false);
  });

  it('excludes inactive menus', () => {
    const r = resolve([
      { id: 'main', priority: 0, isActive: true },
      { id: 'old', priority: 99, isActive: false },
    ]);
    expect(r.order).toEqual(['main']);
  });

  it('flags ambiguity when two active menus share a priority', () => {
    const r = resolve([
      { id: 'a', priority: 5, isActive: true },
      { id: 'b', priority: 5, isActive: true },
    ]);
    expect(r.ambiguous).toBe(true);
  });

  it('does not flag ambiguity when the duplicate priority is inactive', () => {
    const r = resolve([
      { id: 'a', priority: 5, isActive: true },
      { id: 'b', priority: 5, isActive: false },
    ]);
    expect(r.ambiguous).toBe(false);
  });

  it('a branch with no assigned menus resolves to nothing (no implicit global menu)', () => {
    expect(resolve([])).toEqual({ order: [], ambiguous: false });
  });
});
