import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ARCHITECTURE TEST — SRS §5.2.3 DATABASE-OWNERSHIP EDGE, targeted correction.
 *
 * `module-boundaries.spec.ts` proves IMPORT-boundary compliance: it scans for
 * `import`/`export`/`require` specifiers reaching into another module's
 * private directory. It has NO way to detect a module querying another
 * module's TABLE directly through the shared Prisma client — a bare
 * Branch-model lookup imports nothing from Organisation at all, so the
 * import-scan is structurally blind to it. That is exactly the defect
 * this correction fixes (`CashClosePolicyService` originally queried
 * `tx.branch` directly for a branch's base currency) and exactly the gap
 * this file closes for THIS ONE EDGE.
 *
 * ── WHAT THIS FILE DOES AND DOES NOT PROVE ──────────────────────────────────
 * It proves, for the `cash-close-policy/` production files only:
 *   1. no Prisma `Branch`-model property access (`.branch.<crud-verb>`) exists
 *      anywhere in this directory's production code;
 *   2. every Organisation import in this directory reaches ONLY
 *      `organisation/contract` (or the module class, for DI wiring) — the
 *      SAME rule `module-boundaries.spec.ts` enforces repo-wide, re-asserted
 *      narrowly here so this specific edge cannot silently regress even if
 *      the generic suite's exemption list is later loosened elsewhere;
 *   3. the Organisation contract's PRIVATE implementation — not Treasury —
 *      is the one file that still queries `tx.branch` for this fact, proving
 *      the query moved rather than merely being hidden;
 *   4. `module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS` table gained no
 *      `'treasury->organisation'` entry — this correction closes the edge
 *      through the published contract exemption, not by documenting a new
 *      private-path deviation.
 *
 * It does **NOT** prove, and does not claim to prove, that no OTHER module in
 * this repository queries another module's table directly through the shared
 * Prisma client (`CashSessionsService.open`, pre-existing and out of this
 * correction's fence, does exactly that for the same `branches` table — see
 * that file's own TODO surface). **Repo-wide SRS §5.2.3 table-ownership
 * enforcement — e.g. per-module database roles/grants checked in CI — remains
 * PARTIAL.** A general version of this check (scanning every module for
 * property-access patterns against every OTHER module's Prisma model names)
 * is a separate, larger architecture-test slice, not undertaken here.
 */

const CCP_DIR = resolve(__dirname);
const REPO_SRC = resolve(__dirname, '..', '..', '..');
const MODULE_BOUNDARIES_SPEC = join(
  REPO_SRC,
  'modules',
  'module-boundaries.spec.ts',
);
const BRANCH_CURRENCY_IMPL = join(
  REPO_SRC,
  'modules',
  'organisation',
  'branches',
  'branch-currency.query.service.ts',
);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function productionFiles(): string[] {
  return readdirSync(CCP_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(CCP_DIR, f));
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source))) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe('P1G-1 acceptance closure — SRS §5.2.3 database-ownership edge (cash-close-policy)', () => {
  const files = productionFiles();

  it('sanity: this scan actually reaches the production files it claims to', () => {
    const names = files.map((f) => f.split('/').pop());
    expect(names).toEqual(
      expect.arrayContaining([
        'cash-close-policy.service.ts',
        'cash-close-policy.resolver.ts',
        'cash-close-policy.controller.ts',
      ]),
    );
  });

  it('no cash-close-policy production file accesses the Prisma Branch model directly', () => {
    // Matches `tx.branch.<crud>`, `prisma.branch.<crud>`, or any other
    // receiver's `.branch.<crud>` — the exact shape a direct table query
    // takes through the shared Prisma client, independent of the receiver's
    // variable name.
    const branchModelAccess =
      /\.branch\.(findUnique|findFirst|findMany|create|update|upsert|delete|count|aggregate)\s*\(/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (branchModelAccess.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('every Organisation import in cash-close-policy/ reaches only organisation/contract or the module class', () => {
    const offenders: { file: string; spec: string }[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (!spec.includes('organisation')) continue;
        const legal =
          /organisation\/contract($|\/)/.test(spec) ||
          /organisation\/organisation\.module$/.test(spec);
        if (!legal) offenders.push({ file, spec });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Organisation contract implementation — not Treasury — owns the Branch query', () => {
    const source = readFileSync(BRANCH_CURRENCY_IMPL, 'utf8');
    expect(source).toMatch(/tx\.branch\.findUnique\s*\(/);
  });

  it("module-boundaries.spec.ts's KNOWN_DEVIATIONS gained no 'treasury->organisation' entry", () => {
    const source = readFileSync(MODULE_BOUNDARIES_SPEC, 'utf8');
    expect(source).not.toMatch(/'treasury->organisation'/);
  });
});
