import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * ARCHITECTURE TEST — P1E-1B Defect A + P1E-1C's raw-collector bypass, both
 * corrected here.
 *
 * P1E-1B closed one bypass: `src/modules/**` importing the low-level
 * `internal/create-domain-event.ts` constructor directly, which trusts every
 * field a caller supplies, `tenantId` included. P1E-1C closed a SECOND,
 * independent bypass that closing the first one did NOT touch: even with the
 * constructor unreachable, `UnitOfWorkContext` used to expose the raw
 * `DomainEventCollector` as `ctx.events`, and `DomainEventCollector.record()`
 * accepts ANY object shaped like `DomainEventEnvelope` — a type that is
 * legitimately public (Sales/Kitchen contracts need it). Nothing stopped
 * business code from hand-building a fake envelope and calling
 * `ctx.events.record(fake)` directly, skipping trusted construction entirely.
 *
 * `UnitOfWorkContext` no longer exposes `.events` at all (`unit-of-work-context.ts`);
 * the only queue-affecting operation business code can reach is
 * `ctx.publishEvent(...)`, which builds AND enqueues in one trusted call. This
 * file enforces, mechanically, that nothing under `src/modules/**` can
 * route around that by reaching for the underlying machinery directly.
 *
 * ── WHAT COUNTS AS A VIOLATION ────────────────────────────────────────────
 * Any non-test file under `src/modules/**` that:
 *
 *   (A) imports anything from `src/common/domain-events/internal/` (by
 *       relative path, or — defensive backstop, no path aliases exist today —
 *       a specifier containing the literal substring `domain-events/internal`);
 *   (B) imports `DomainEventCollector` (by relative path resolving to
 *       `domain-event-collector.ts`, or a specifier containing the literal
 *       substring `domain-event-collector`);
 *   (C) contains the literal source pattern `.events.record(` — the raw
 *       collector-mutation call shape. This is a textual check, not an import
 *       check: even if a file somehow obtained a collector reference some
 *       other way, this catches the ACT of calling `.record()` on one.
 *
 * ── WHAT IS DELIBERATELY EXEMPTED ────────────────────────────────────────
 * `*.spec.ts` files under `src/modules/**` MAY still do any of the above. They
 * use the low-level machinery purely to test a PUBLIC CONTRACT's shape (event
 * name, version, payload fields) — e.g. `sales/contract/events.spec.ts` calls
 * `createDomainEvent(...)` to build a fixture envelope and assert on its
 * fields. That fixture never reaches a real transaction, a real handler, or a
 * real tenant. PUBLIC EVENT CONTRACT TYPES (`DomainEventEnvelope`,
 * `OrderLineFiredPayload`, etc. — declared directly in
 * `modules/*\/contract/events.ts`, never re-exported from `internal/`) stay
 * freely importable by anyone; INTERNAL AUTHORITATIVE ENVELOPE CONSTRUCTION
 * AND THE RAW COLLECTOR are restricted to `common/domain-events/` and to
 * tests exercising a contract's shape — never to business code that could
 * feed a constructed envelope into a real operation.
 */

const SRC_ROOT = resolve(__dirname, '../..');
const MODULES_ROOT = join(SRC_ROOT, 'modules');
const INTERNAL_DIR = resolve(__dirname, 'internal');
const COLLECTOR_FILE = resolve(__dirname, 'domain-event-collector');

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const RAW_RECORD_RE = /\.events\.record\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface ImportViolation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: 'internal' | 'collector';
}

function findImportViolations(): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const file of walk(MODULES_ROOT)) {
    if (file.endsWith('.spec.ts')) continue; // exempted — see file docblock

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;

      let reason: ImportViolation['reason'] | null = null;
      if (specifier.includes('domain-events/internal')) {
        reason = 'internal';
      } else if (specifier.includes('domain-event-collector')) {
        reason = 'collector';
      } else if (specifier.startsWith('.')) {
        const resolved = resolve(file, '..', specifier);
        if (!relative(INTERNAL_DIR, resolved).startsWith('..')) {
          reason = 'internal';
        } else if (resolved === COLLECTOR_FILE) {
          reason = 'collector';
        }
      }
      if (reason) {
        violations.push({ file: relative(SRC_ROOT, file), specifier, reason });
      }
    }
  }
  return violations;
}

interface RawRecordViolation {
  readonly file: string;
}

function findRawRecordViolations(): RawRecordViolation[] {
  const violations: RawRecordViolation[] = [];
  for (const file of walk(MODULES_ROOT)) {
    if (file.endsWith('.spec.ts')) continue; // exempted — see file docblock
    const source = readFileSync(file, 'utf8');
    if (RAW_RECORD_RE.test(source)) {
      violations.push({ file: relative(SRC_ROOT, file) });
    }
  }
  return violations;
}

describe('trusted event construction & publication boundary (P1E-1B/C)', () => {
  it('no business file under src/modules/** imports common/domain-events/internal', () => {
    expect(
      findImportViolations().filter((v) => v.reason === 'internal'),
    ).toEqual([]);
  });

  it('no business file under src/modules/** imports DomainEventCollector', () => {
    expect(
      findImportViolations().filter((v) => v.reason === 'collector'),
    ).toEqual([]);
  });

  it('no business file under src/modules/** calls the raw `.events.record(` collector API', () => {
    expect(findRawRecordViolations()).toEqual([]);
  });

  it('the internal constructor and the collector still exist at their expected paths', () => {
    // Sanity check that the tests above are not vacuously passing because a
    // file moved somewhere the walker cannot see.
    expect(() =>
      readFileSync(join(INTERNAL_DIR, 'create-domain-event.ts'), 'utf8'),
    ).not.toThrow();
    expect(() => readFileSync(`${COLLECTOR_FILE}.ts`, 'utf8')).not.toThrow();
  });

  it('a business (non-.spec) file importing the internal constructor IS flagged (self-test)', () => {
    // Not a real repository file — proves the detector actually fires rather
    // than always returning an empty array.
    const fakeFile = join(MODULES_ROOT, 'sales', '__not_a_real_file__.ts');
    const fakeSource =
      "import { createDomainEvent } from '../../common/domain-events/internal/create-domain-event';\n";
    const matches = [...fakeSource.matchAll(IMPORT_RE)];
    expect(matches).toHaveLength(1);
    const specifier = matches[0][1] ?? matches[0][2];
    expect(specifier).toBeDefined();
    const resolved = resolve(fakeFile, '..', specifier);
    expect(relative(INTERNAL_DIR, resolved).startsWith('..')).toBe(false);
  });

  it('a business (non-.spec) file importing DomainEventCollector directly IS flagged (self-test)', () => {
    const fakeFile = join(MODULES_ROOT, 'sales', '__not_a_real_file__.ts');
    const fakeSource =
      "import { DomainEventCollector } from '../../common/domain-events/domain-event-collector';\n";
    const matches = [...fakeSource.matchAll(IMPORT_RE)];
    expect(matches).toHaveLength(1);
    const specifier = matches[0][1] ?? matches[0][2];
    expect(specifier).toBeDefined();
    const resolved = resolve(fakeFile, '..', specifier);
    expect(resolved).toBe(COLLECTOR_FILE);
  });

  it('a business (non-.spec) file calling ctx.events.record(...) IS flagged (self-test)', () => {
    const fakeSource = 'ctx.events.record(fakeEnvelope);\n';
    expect(RAW_RECORD_RE.test(fakeSource)).toBe(true);
    expect(RAW_RECORD_RE.test('ctx.publishEvent(input);\n')).toBe(false);
  });

  it('sales/contract/events.ts imports PUBLIC envelope TYPES, not internal construction or the collector', () => {
    const source = readFileSync(
      join(MODULES_ROOT, 'sales/contract/events.ts'),
      'utf8',
    );
    expect(source).toContain(
      "from '../../../common/domain-events/domain-event.types'",
    );
    expect(source).not.toContain('domain-events/internal');
    expect(source).not.toContain('domain-event-collector');
    expect(RAW_RECORD_RE.test(source)).toBe(false);
  });

  it('kitchen/contract/events.ts imports PUBLIC envelope TYPES, not internal construction or the collector', () => {
    const source = readFileSync(
      join(MODULES_ROOT, 'kitchen/contract/events.ts'),
      'utf8',
    );
    expect(source).toContain(
      "from '../../../common/domain-events/domain-event.types'",
    );
    expect(source).not.toContain('domain-events/internal');
    expect(source).not.toContain('domain-event-collector');
    expect(RAW_RECORD_RE.test(source)).toBe(false);
  });

  it('sales/contract/events.spec.ts (a test file) MAY import the internal constructor', () => {
    const source = readFileSync(
      join(MODULES_ROOT, 'sales/contract/events.spec.ts'),
      'utf8',
    );
    expect(source).toContain('domain-events/internal/create-domain-event');
  });
});
