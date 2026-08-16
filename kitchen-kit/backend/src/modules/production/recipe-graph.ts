/**
 * Recipe graph rules — pure functions, no I/O, no Prisma.
 *
 * Two things live here and nothing else:
 *
 *   1. BR-MNU-001 / FR-MNU-042 cycle detection, which must reject the change
 *      and display the FULL cycle path.
 *   2. D-17-03 scope precedence + the D-17-08 version-selection rule.
 *
 * Both are pure so they are provable in unit tests without a database, and so
 * the D-17-08 guarantee ("`effective_from` never selects a version") is visible
 * by inspection: no function in this file accepts an effective date at all.
 */

// ---------------------------------------------------------------- cycles ---

/** One directed edge: a recipe that references another recipe as a component. */
export interface SubRecipeEdge {
  /** The recipe that OWNS the line. */
  fromRecipeId: string;
  /** The recipe used as a component. */
  toRecipeId: string;
}

/**
 * BR-MNU-001 — detect a cycle reachable from `startRecipeId`.
 *
 * Returns the full path of the offending cycle (`A -> B -> C -> A`) or `null`
 * when the graph is acyclic from that root. The returned array repeats the
 * entry node at both ends so the caller can render the closed loop verbatim,
 * which is what FR-MNU-042 ("displaying the full cycle path") asks for.
 *
 * NO DEPTH LIMIT IS IMPOSED. BR-MNU-003's "depth limit of 10" governs COST
 * expansion, which D-17-05 defers; importing it into cycle detection would
 * invent a rule the SRS does not state. Termination is guaranteed by the
 * visited set, not by a depth cap.
 */
export function findCycle(
  startRecipeId: string,
  edges: SubRecipeEdge[],
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.fromRecipeId);
    if (list) list.push(e.toRecipeId);
    else adjacency.set(e.fromRecipeId, [e.toRecipeId]);
  }

  const onPath = new Set<string>();
  const settled = new Set<string>();
  const path: string[] = [];

  const walk = (node: string): string[] | null => {
    if (onPath.has(node)) {
      // Close the loop from its first appearance on the current path.
      return [...path.slice(path.indexOf(node)), node];
    }
    if (settled.has(node)) return null;

    onPath.add(node);
    path.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(node);
    settled.add(node);
    return null;
  };

  return walk(startRecipeId);
}

/**
 * Convenience wrapper for the "would this new line create a cycle?" question.
 * The prospective edge is appended to the known graph before searching, so the
 * check runs ON SAVE as BR-MNU-001 requires, never after the fact.
 */
export function wouldCreateCycle(
  ownerRecipeId: string,
  componentRecipeId: string,
  existingEdges: SubRecipeEdge[],
): string[] | null {
  return findCycle(ownerRecipeId, [
    ...existingEdges,
    { fromRecipeId: ownerRecipeId, toRecipeId: componentRecipeId },
  ]);
}

// ----------------------------------------------------------- resolution ---

export type RecipeScopeValue = 'tenant' | 'brand' | 'branch';

export interface ScopedRecipe {
  id: string;
  scope: RecipeScopeValue;
  brandId: string | null;
  branchId: string | null;
}

/**
 * D-17-03 scope precedence: **branch > brand > tenant**.
 *
 * This precedence is ANALOGY-DERIVED from FR-PLT-025's settings hierarchy. It
 * is NOT a recipe-specific SRS requirement — FR-MNU-047 [S] establishes only
 * that a branch may hold a variant differing from the brand standard, and
 * states no precedence. D-17-03 records the analogy explicitly and this
 * implementation preserves that framing rather than presenting it as SRS text.
 *
 * Given the candidate recipes for one target, returns the single applicable
 * recipe identity for a branch context, or `null` when none applies.
 */
export function resolveRecipeByScope(
  candidates: ScopedRecipe[],
  context: { branchId?: string | null; brandId?: string | null },
): ScopedRecipe | null {
  const branchMatch = context.branchId
    ? candidates.find(
        (r) => r.scope === 'branch' && r.branchId === context.branchId,
      )
    : undefined;
  if (branchMatch) return branchMatch;

  const brandMatch = context.brandId
    ? candidates.find(
        (r) => r.scope === 'brand' && r.brandId === context.brandId,
      )
    : undefined;
  if (brandMatch) return brandMatch;

  return candidates.find((r) => r.scope === 'tenant') ?? null;
}

export type RecipeVersionStatusValue = 'draft' | 'published' | 'superseded';

export interface SelectableVersion {
  id: string;
  version: number;
  status: RecipeVersionStatusValue;
}

/**
 * D-17-08 — THE version-selection rule, in full.
 *
 * The effective version is the single version whose `status` is `published`.
 * That is the entire rule. There is no date comparison, no reference instant,
 * no clock, no timezone, no tie-break and no ordering: uniqueness is guaranteed
 * structurally by the partial unique index
 * `UNIQUE (recipe_id) WHERE status = 'published'`.
 *
 * `effective_from` is INFORMATIONAL ONLY (D-17-08 Q2) and is deliberately not a
 * parameter of this function, so it is impossible for it to influence the
 * outcome. Q3, Q4 and Q5 are Not Applicable in consequence.
 *
 * Returns `null` when no version is published. That is not an error and does
 * NOT fall back to a superseded or draft version; downstream handling of the
 * "no recipe" state belongs to Sales under BR-MNU-012 and is out of scope.
 */
export function selectPublishedVersion<T extends SelectableVersion>(
  versions: T[],
): T | null {
  return versions.find((v) => v.status === 'published') ?? null;
}

/**
 * Version numbering. `version` is NOT NULL and unique per recipe, so a draft
 * needs a number the moment it is inserted; §7.4.4's "incremented on publish"
 * describes the intent that each publication yields a new number, and cannot
 * mean the column is populated at publish time.
 *
 * A concurrent race may hand two drafts the same number; `uq_recipe_version`
 * rejects the loser, which is the intended guarantee — the constraint is the
 * authority, not this function.
 */
export function nextVersionNumber(existing: { version: number }[]): number {
  return existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}
