import {
  ResolvedServiceChargePolicyVersion,
  ServiceChargePolicyBreakdownEntry,
  computeWinningVersion,
} from './service-charge-policy.resolver';
import type { ServiceChargePolicyRule } from './service-charge-policy-rules';

/**
 * PURE unit tests for `computeWinningVersion` — the precedence/lock walk in
 * total isolation from Prisma, RLS, and the wall clock (P2D §15 items
 * 2-8). The database-backed half (no-policy => null, future invisibility,
 * historical-resolve stability, cross-tenant rejection — items 1, 9-12) is
 * proven in `test/service-charge-policy.e2e-spec.ts`, which needs a real
 * database.
 *
 * P2D-CORRECTION (2026-09-10): this file previously proved the correct
 * semantics implicitly (via `toBe(...)` identity checks) but the P2D
 * report's own prose (§13) mischaracterized the algorithm as "the first
 * level carrying ANY version wins, locked or not." That prose was WRONG —
 * `computeWinningVersion` (source, unchanged by this correction) has
 * always implemented the RATIFIED P2D-R1 semantics: a lower CONFIGURED
 * level overrides a higher one UNLESS the currently-effective higher
 * level is LOCKED, in which case the walk stops there. This file now
 * states that algorithm explicitly and asserts `.id`/`.level`/`.locked`
 * (not just object identity) for every one of the ten scenarios the
 * correction task enumerates, so the intended semantics are executable
 * and unambiguous — see `docs/reports/claude/2026-09-10_FULL-SRS-PLT-
 * SERVICE-CHARGE-POLICY-P2D-CORRECTION.md`.
 */

let versionCounter = 0;
function version(
  overrides: Partial<{
    level: 'tenant' | 'brand' | 'branch';
    locked: boolean;
    rules: readonly ServiceChargePolicyRule[];
  }> = {},
): ResolvedServiceChargePolicyVersion {
  versionCounter += 1;
  return {
    id: `version-${versionCounter}`,
    level: overrides.level ?? 'tenant',
    targetId: `target-${versionCounter}`,
    rules: overrides.rules ?? [],
    locked: overrides.locked ?? false,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function entry(
  level: 'tenant' | 'brand' | 'branch',
  opts: {
    eligible?: boolean;
    targetId?: string | null;
    version?: ResolvedServiceChargePolicyVersion | null;
  } = {},
): ServiceChargePolicyBreakdownEntry {
  return {
    level,
    eligible: opts.eligible ?? true,
    targetId: opts.targetId ?? `target-${level}`,
    version: opts.version ?? null,
  };
}

/** Asserts the winner is EXACTLY this version — id, level, AND locked. */
function expectWinner(
  winner: ResolvedServiceChargePolicyVersion | null,
  expected: ResolvedServiceChargePolicyVersion,
) {
  expect(winner).not.toBeNull();
  expect(winner?.id).toBe(expected.id);
  expect(winner?.level).toBe(expected.level);
  expect(winner?.locked).toBe(expected.locked);
}

describe('computeWinningVersion (P2D precedence/lock walk — P2D-R1: lower CONFIGURED level overrides higher UNLESS the higher is LOCKED)', () => {
  it('1. no policy anywhere => null', () => {
    const entries = [entry('tenant'), entry('brand'), entry('branch')];
    expect(computeWinningVersion(entries)).toBeNull();
  });

  it('2. tenant only => tenant', () => {
    const tenantV = version({ level: 'tenant' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand'),
      entry('branch'),
    ];
    expectWinner(computeWinningVersion(entries), tenantV);
  });

  it('3. tenant unlocked + brand configured => brand (lower overrides higher unlocked)', () => {
    const tenantV = version({ level: 'tenant', locked: false });
    const brandV = version({ level: 'brand' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch'),
    ];
    expectWinner(computeWinningVersion(entries), brandV);
  });

  it('4. tenant unlocked + brand unlocked + branch configured => branch', () => {
    const tenantV = version({ level: 'tenant', locked: false });
    const brandV = version({ level: 'brand', locked: false });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), branchV);
  });

  it('5. tenant locked + brand + branch configured => tenant (lock stops the walk immediately)', () => {
    const tenantV = version({ level: 'tenant', locked: true });
    const brandV = version({ level: 'brand' });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), tenantV);
  });

  it('6. tenant unlocked + brand locked + branch configured => brand (branch never reached)', () => {
    const tenantV = version({ level: 'tenant', locked: false });
    const brandV = version({ level: 'brand', locked: true });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), brandV);
  });

  it('7. tenant unlocked + brand unlocked + branch locked => branch, reported locked', () => {
    const tenantV = version({ level: 'tenant', locked: false });
    const brandV = version({ level: 'brand', locked: false });
    const branchV = version({ level: 'branch', locked: true });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), branchV);
  });

  it('8. empty tenant rules [] unlocked + brand configured => brand (empty rules is a real, but unlocked, configured version)', () => {
    const tenantV = version({ level: 'tenant', locked: false, rules: [] });
    const brandV = version({ level: 'brand' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch'),
    ];
    expectWinner(computeWinningVersion(entries), brandV);
  });

  it('9. empty brand rules [] unlocked + branch configured => branch', () => {
    const brandV = version({ level: 'brand', locked: false, rules: [] });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant'),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), branchV);
  });

  it('10. empty brand rules [] LOCKED + branch configured => brand (empty rules still locks exactly like a non-empty version)', () => {
    const brandV = version({ level: 'brand', locked: true, rules: [] });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant'),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), brandV);
    expect(computeWinningVersion(entries)?.rules).toEqual([]);
  });

  it('an ineligible level (no brandId/branchId in scope) never contributes, even if a version object were present', () => {
    const brandV = version({ level: 'brand' });
    const entries = [
      entry('tenant'),
      // eligible: false — e.g. no brandId supplied for this request.
      entry('brand', { eligible: false, targetId: null, version: brandV }),
      entry('branch'),
    ];
    expect(computeWinningVersion(entries)).toBeNull();
  });

  it('walk order is strictly tenant -> brand -> branch, independent of array construction order elsewhere', () => {
    // A locked tenant version must stop the walk even though brand/branch
    // entries are constructed with "earlier" ids — proves the walk uses
    // ARRAY POSITION (tenant, brand, branch, in that order), not id
    // ordering or insertion order.
    const brandV = version({ level: 'brand' });
    const branchV = version({ level: 'branch' });
    const tenantV = version({ level: 'tenant', locked: true });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expectWinner(computeWinningVersion(entries), tenantV);
  });
});
