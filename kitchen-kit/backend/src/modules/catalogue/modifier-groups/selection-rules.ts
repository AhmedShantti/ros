import { BadRequestException } from '@nestjs/common';

/**
 * Modifier-group selection invariants, SRS §7.3 #8 and FR-MNU-011:
 *   - min ≤ max
 *   - required ⇒ min ≥ 1
 *
 * Mirrored by the DB CHECK constraints `ck_min_le_max` and `ck_required_min`
 * (from the approved SQL), so the database remains the final boundary; this
 * function exists to return a clear 400 rather than a raw constraint violation.
 */
export function violatesSelectionRules(
  minSelections: number,
  maxSelections: number,
  isRequired: boolean,
): string | null {
  if (minSelections > maxSelections) {
    return 'minSelections must be less than or equal to maxSelections.';
  }
  if (isRequired && minSelections < 1) {
    return 'A required modifier group must have minSelections of at least 1.';
  }
  return null;
}

export function assertSelectionRules(
  minSelections: number,
  maxSelections: number,
  isRequired: boolean,
): void {
  const problem = violatesSelectionRules(
    minSelections,
    maxSelections,
    isRequired,
  );
  if (problem) {
    throw new BadRequestException(problem);
  }
}
