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

describe('computeWinningVersion (P2D precedence/lock walk)', () => {
  it('2. no policy anywhere => null', () => {
    const entries = [entry('tenant'), entry('brand'), entry('branch')];
    expect(computeWinningVersion(entries)).toBeNull();
  });

  it('tenant version => tenant wins (3)', () => {
    const tenantV = version({ level: 'tenant' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand'),
      entry('branch'),
    ];
    expect(computeWinningVersion(entries)).toBe(tenantV);
  });

  it('tenant + brand => brand wins (4)', () => {
    const tenantV = version({ level: 'tenant' });
    const brandV = version({ level: 'brand' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch'),
    ];
    expect(computeWinningVersion(entries)).toBe(brandV);
  });

  it('tenant + brand + branch => branch wins (5)', () => {
    const tenantV = version({ level: 'tenant' });
    const brandV = version({ level: 'brand' });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expect(computeWinningVersion(entries)).toBe(branchV);
  });

  it('tenant locked => tenant wins, brand/branch blocked (6)', () => {
    const tenantV = version({ level: 'tenant', locked: true });
    const brandV = version({ level: 'brand' });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expect(computeWinningVersion(entries)).toBe(tenantV);
  });

  it('brand locked => brand wins, branch blocked (7)', () => {
    const tenantV = version({ level: 'tenant' });
    const brandV = version({ level: 'brand', locked: true });
    const branchV = version({ level: 'branch' });
    const entries = [
      entry('tenant', { version: tenantV }),
      entry('brand', { version: brandV }),
      entry('branch', { version: branchV }),
    ];
    expect(computeWinningVersion(entries)).toBe(brandV);
  });

  it('branch locked => branch resolves locked (8)', () => {
    const branchV = version({ level: 'branch', locked: true });
    const entries = [
      entry('tenant'),
      entry('brand'),
      entry('branch', { version: branchV }),
    ];
    const winner = computeWinningVersion(entries);
    expect(winner).toBe(branchV);
    expect(winner?.locked).toBe(true);
  });

  it('an empty rules [] version is a CONFIGURED winner, never treated as inheritance (9)', () => {
    const branchV = version({ level: 'branch', rules: [] });
    const entries = [
      entry('tenant', { version: version({ level: 'tenant' }) }),
      entry('brand'),
      entry('branch', { version: branchV }),
    ];
    const winner = computeWinningVersion(entries);
    expect(winner).toBe(branchV);
    expect(winner?.rules).toEqual([]);
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
    expect(computeWinningVersion(entries)).toBe(tenantV);
  });
});
