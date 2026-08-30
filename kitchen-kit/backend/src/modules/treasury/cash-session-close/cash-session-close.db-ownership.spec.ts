import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ARCHITECTURE TEST — SRS §5.2.3 DATABASE-OWNERSHIP EDGE, P1G-1 migration 34.
 *
 * Sibling to `cash-close-policy/cash-close-policy.db-ownership.spec.ts` (see
 * that file's docblock for why `module-boundaries.spec.ts`'s import-scan
 * cannot, by itself, detect a direct cross-module Prisma table query — a bare
 * `tx.branch.findUnique(...)` imports nothing from Organisation at all).
 *
 * This slice widens the same targeted proof to TWO new production
 * directories, and closes the exact gap that earlier file's docblock named
 * as still open ("`CashSessionsService.open`... does exactly that [direct
 * `tx.branch` query]... out of this correction's fence" — no longer true;
 * see the second `it` below):
 *
 *   1. `cash-sessions/`      — `CashSessionsService.open` now resolves branch
 *                              currency through `organisation/contract`'s
 *                              `BRANCH_CURRENCY_QUERY`, not `tx.branch`
 *                              directly (final implementation slice §8).
 *   2. `cash-session-close/` — the CashSession Close feature reads Sales'
 *      cash/rounding tender totals through `sales/contract`'s
 *      `CASH_SESSION_TENDER_TOTALS_QUERY` (published for exactly this
 *      purpose — `sales/contract/cash-session-tender-totals.query.ts`), and
 *      MUST NOT query `sales.orders` / `sales.order_payments` directly
 *      through the shared Prisma client.
 *
 * Same scope discipline as the sibling file: this proves ONLY these two
 * directories are clean of the specific patterns checked. It is not a
 * general "no module queries another module's table" scanner across the
 * whole repository — that remains a separate, larger architecture-test
 * slice, not undertaken here.
 */

const TREASURY_DIR = resolve(__dirname, '..');
const CASH_SESSIONS_DIR = join(TREASURY_DIR, 'cash-sessions');
const CASH_SESSION_CLOSE_DIR = join(TREASURY_DIR, 'cash-session-close');
const REPO_SRC = resolve(__dirname, '..', '..', '..');
const CASH_SESSIONS_SERVICE = join(
  CASH_SESSIONS_DIR,
  'cash-sessions.service.ts',
);
const BRANCH_CURRENCY_IMPL = join(
  REPO_SRC,
  'modules',
  'organisation',
  'branches',
  'branch-currency.query.service.ts',
);
const TENDER_TOTALS_IMPL = join(
  REPO_SRC,
  'modules',
  'sales',
  'orders',
  'cash-session-tender-totals.query.service.ts',
);

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function productionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(dir, f));
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

/** `.branch.<crud>` / `.orderPayment.<crud>` / `.order.<crud>` through ANY receiver. */
function directModelAccess(model: string): RegExp {
  return new RegExp(
    `\\.${model}\\.(findUnique|findFirst|findMany|create|update|upsert|delete|count|aggregate|groupBy)\\s*\\(`,
  );
}

describe('P1G-1 migration 34 — SRS §5.2.3 database-ownership edge (cash-sessions, cash-session-close)', () => {
  const cashSessionsFiles = productionFiles(CASH_SESSIONS_DIR);
  const closeFiles = productionFiles(CASH_SESSION_CLOSE_DIR);
  const allFiles = [...cashSessionsFiles, ...closeFiles];

  it('sanity: this scan actually reaches the production files it claims to', () => {
    const names = allFiles.map((f) => f.split('/').pop());
    expect(names).toEqual(
      expect.arrayContaining([
        'cash-sessions.service.ts',
        'cash-session-close.service.ts',
        'cash-session-close.dto.ts',
      ]),
    );
  });

  it('CashSessionsService.open no longer accesses the Prisma Branch model directly (the correction this slice carries forward)', () => {
    const source = readFileSync(CASH_SESSIONS_SERVICE, 'utf8');
    expect(source).not.toMatch(directModelAccess('branch'));
  });

  it('no cash-sessions/ or cash-session-close/ production file accesses the Prisma Branch model directly', () => {
    const offenders = allFiles.filter((file) =>
      directModelAccess('branch').test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('no cash-sessions/ or cash-session-close/ production file accesses the Prisma Order/OrderPayment models directly', () => {
    const offenders: { file: string; model: string }[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, 'utf8');
      for (const model of ['order', 'orderPayment']) {
        if (directModelAccess(model).test(source)) {
          offenders.push({ file, model });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every Organisation import in these directories reaches only organisation/contract or the module class', () => {
    const offenders: { file: string; spec: string }[] = [];
    for (const file of allFiles) {
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

  it('every Sales import in these directories reaches only sales/contract or the module class', () => {
    const offenders: { file: string; spec: string }[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (!spec.includes('/sales/') && !spec.includes('../sales')) continue;
        const legal =
          /sales\/contract($|\/)/.test(spec) ||
          /sales\/sales\.module$/.test(spec);
        if (!legal) offenders.push({ file, spec });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every Governance import in these directories reaches only governance/contract, governance/audit, or the module class', () => {
    const offenders: { file: string; spec: string }[] = [];
    for (const file of allFiles) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (!spec.includes('governance')) continue;
        const legal =
          /governance\/contract($|\/)/.test(spec) ||
          /governance\/audit($|\/)/.test(spec) ||
          /governance\/governance\.module$/.test(spec);
        if (!legal) offenders.push({ file, spec });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Organisation contract implementation — not Treasury — owns the Branch query', () => {
    const source = readFileSync(BRANCH_CURRENCY_IMPL, 'utf8');
    expect(source).toMatch(/tx\.branch\.findUnique\s*\(/);
  });

  it('the Sales contract implementation — not Treasury — owns the OrderPayment query', () => {
    const source = readFileSync(TENDER_TOTALS_IMPL, 'utf8');
    expect(source).toMatch(/tx\.orderPayment\.groupBy\s*\(/);
  });
});
