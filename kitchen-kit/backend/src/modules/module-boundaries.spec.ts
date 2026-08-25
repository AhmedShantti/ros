import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * ARCHITECTURE TEST — SRS §5.2.3 / §5.4 module boundaries.
 *
 * §5.2.3 lists "A module MUST NOT import from another module's internal
 * directory" and "Cross-module communication is via a published interface or a
 * domain event", and states that these rules are "enforced mechanically, not by
 * convention", with the enforcement named as an ESLint boundary rule and an
 * architecture test suite. §5.4 fixes what "published" means: every module has a
 * `contract/` directory, marked "PUBLIC. Other modules may import only this."
 *
 * This file is the architecture test half. It reads the source tree statically —
 * no Nest container, no database — so it fails fast in the unit suite and cannot
 * be satisfied by a module that merely happens not to be instantiated.
 *
 * ── WHAT COUNTS AS A LEGAL CROSS-MODULE IMPORT ──────────────────────────────
 *   modules/<other>/contract            · §5.4's published surface
 *   modules/<other>/contract/<file>     · same
 *   modules/<other>/<other>.module      · the Nest composition root. Importing
 *                                         the module CLASS is how a consumer
 *                                         wires the provider it was granted; it
 *                                         exposes no domain type and is not an
 *                                         "internal directory" in §5.2.3's
 *                                         sense. Without this exemption the rule
 *                                         would forbid dependency injection
 *                                         itself.
 * Everything else — a service, a repository, an entity, a DTO, a `.port.ts`
 * reached through a private subdirectory — is a violation.
 */

const MODULES_ROOT = resolve(__dirname);

/** `import ... from '<spec>'` / `export ... from '<spec>'` / `require('<spec>')`. */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * PRE-EXISTING deviations — recorded exactly, not silently tolerated.
 *
 * NO module in this repository has a `contract/` directory except Workforce,
 * which this run created. Every other cross-module edge therefore reaches into a
 * private directory, and closing them all would be a repo-wide refactor of
 * slices this run is not authorised to touch. Freezing them here is the honest
 * alternative to either deleting the rule or pretending it passes.
 *
 * The allow-list is keyed by `importer->imported` and names every INNER PATH
 * reached. A NEW private path — even between a pair already listed — fails the
 * suite. That is the property that matters: the debt can shrink, and cannot grow.
 *
 * Two categories, which should be closed differently:
 *
 *   (a) CROSS-CUTTING HTTP/AUTH PLUMBING — `identity/auth/guards/*`,
 *       `identity/authz/*`, `identity/context/*`, `governance/audit/*`,
 *       `organisation/prisma-errors`. Every HTTP module imports these. Under SRS
 *       §5.4 that is not really a module-to-module dependency at all; it is
 *       framework plumbing that belongs in `shared/` ("Shared code lives in
 *       shared/ and MUST NOT contain business logic" — §5.2.3). Relocating it is
 *       the correct fix, and it is a dedicated slice.
 *
 *   (b) GENUINE DOMAIN EDGES — `identity->localisation` (`tax-class.port`),
 *       `inventory->production` (`recipe-cost.port`), `sales->catalogue`,
 *       `sales->localisation`, `sales->production`. These are the §5.5.1
 *       interface calls the context map describes, published in the wrong place.
 *       Each is closed by moving its port under `modules/<module>/contract/`,
 *       exactly as Workforce now does — by the slice that owns it.
 *
 * `workforce` appears in neither list, and must not.
 */
const KNOWN_DEVIATIONS: Readonly<Record<string, readonly string[]>> = {
  'catalogue->governance': ['audit/audit.module', 'audit/audit.service'],
  'catalogue->identity': [
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
  'catalogue->organisation': ['operating-hours/time-of-day', 'prisma-errors'],
  'identity->governance': ['audit/audit.service'],
  'identity->localisation': ['tax/tax-class.port'],
  'inventory->governance': ['audit/audit.module', 'audit/audit.service'],
  'inventory->identity': [
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
  'inventory->organisation': ['prisma-errors'],
  'inventory->production': ['costing/recipe-cost.port'],
  'organisation->governance': ['audit/audit.module', 'audit/audit.service'],
  'organisation->identity': [
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
  'production->governance': ['audit/audit.module', 'audit/audit.service'],
  'production->identity': [
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
  'production->organisation': ['prisma-errors'],
  'sales->catalogue': ['pricing/price-resolution.service'],
  'sales->governance': ['audit/audit.module', 'audit/audit.service'],
  'sales->identity': [
    'auth/auth.types',
    'auth/decorators/current-principal.decorator',
    'auth/decorators/pos-session.decorator',
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
  'sales->localisation': [
    'country-pack/country-pack.registry',
    'country-pack/country-pack.service',
    'tax/tax-class.service',
    'tax/tax-engine.registry',
    'tax/tax.calculator',
    'tax/tax.model',
  ],
  'sales->production': ['costing/recipe-cost', 'costing/recipe-cost.service'],
  'treasury->governance': ['audit/audit.module', 'audit/audit.service'],
  'treasury->identity': [
    'auth/auth.types',
    'auth/decorators/current-principal.decorator',
    'auth/decorators/pos-session.decorator',
    'auth/guards/jwt-auth.guard',
    'authz/decorators/require-permission.decorator',
    'authz/guards/permission.guard',
    'authz/permissions.constants',
    'context/current-tenant-context.decorator',
    'context/tenant-context',
    'context/tenant-context.guard',
  ],
};

interface Violation {
  readonly file: string;
  readonly importer: string;
  readonly imported: string;
  /** The path INSIDE the imported module, e.g. `shifts/shift.port`. */
  readonly inner: string;
  readonly specifier: string;
}

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

/** The module a file belongs to, i.e. the first path segment under `modules/`. */
function moduleOf(file: string): string | null {
  const rel = relative(MODULES_ROOT, file);
  if (rel.startsWith('..')) return null;
  const [first, ...rest] = rel.split('/');
  return rest.length > 0 ? first : null;
}

/**
 * Resolve a relative specifier against the importing file and report which
 * module it lands in, plus the path INSIDE that module.
 */
function resolveTarget(
  file: string,
  specifier: string,
): { module: string; inner: string } | null {
  if (!specifier.startsWith('.')) return null;
  const abs = resolve(file, '..', specifier);
  const rel = relative(MODULES_ROOT, abs);
  if (rel.startsWith('..')) return null; // outside modules/ — shared, prisma, common
  const [first, ...rest] = rel.split('/');
  if (rest.length === 0) return null;
  return { module: first, inner: rest.join('/') };
}

function isPublicSurface(target: { module: string; inner: string }): boolean {
  return (
    target.inner === 'contract' ||
    target.inner.startsWith('contract/') ||
    target.inner === `${target.module}.module`
  );
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(MODULES_ROOT)) {
    const importer = moduleOf(file);
    if (importer === null) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const target = resolveTarget(file, specifier);
      if (target === null || target.module === importer) continue;
      if (isPublicSurface(target)) continue;
      violations.push({
        file: relative(MODULES_ROOT, file),
        importer,
        imported: target.module,
        inner: target.inner,
        specifier,
      });
    }
  }
  return violations;
}

describe('module boundaries (SRS §5.2.3, §5.4)', () => {
  const violations = findViolations();

  /**
   * The correction this test was written for.
   *
   * Treasury previously reached `workforce/shifts/shift.port` — a PRIVATE
   * subdirectory. The Shift-opening command now lives in
   * `workforce/contract/`, and this assertion is what stops it moving back.
   */
  it('Treasury imports no Workforce private directory', () => {
    const offending = violations.filter(
      (v) => v.importer === 'treasury' && v.imported === 'workforce',
    );
    expect(offending).toEqual([]);
  });

  it('Workforce publishes its Shift-opening command through contract/', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'workforce/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './commands'");

    const consumer = readFileSync(
      join(MODULES_ROOT, 'treasury/cash-sessions/cash-sessions.service.ts'),
      'utf8',
    );
    expect(consumer).toContain("from '../../workforce/contract'");
    expect(consumer).not.toContain('workforce/shifts');
  });

  /**
   * P1E-1 — the module-contract substrate the future Fire event needs.
   * Sales publishes `order.line.fired`'s typed contract; nothing under
   * `sales/orders/` (the private implementation) is exposed by it.
   */
  it('Sales publishes a public contract directory (order.line.fired, order.opened)', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'sales/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './events'");
    const events = readFileSync(
      join(MODULES_ROOT, 'sales/contract/events.ts'),
      'utf8',
    );
    expect(events).toContain("'order.line.fired'");
    // P1E-6 — the real Fire producer's second published event.
    expect(events).toContain("'order.opened'");
    expect(events).not.toMatch(/:\s*any\b|<any>|\bas any\b/);
  });

  /**
   * P1E-6 — Catalogue Fire-facts (categoryIds, Kitchen/KDS display name).
   * Mirrors the P1E-3A `RoutingConfigQuery` pattern: a narrow, PUBLIC,
   * transaction-aware query contract, so the existing PRIVATE
   * `sales->catalogue` deviation (`pricing/price-resolution.service`) is not
   * reopened or expanded by Fire.
   */
  it('Catalogue publishes a public Fire-facts contract, and Sales consumes only that contract', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'catalogue/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './fire-facts.query'");
    const query = readFileSync(
      join(MODULES_ROOT, 'catalogue/contract/fire-facts.query.ts'),
      'utf8',
    );
    expect(query).toContain('CatalogueFireFactsQuery');
    expect(query).not.toMatch(/:\s*any\b|<any>|\bas any\b/);

    const fireService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-fire.service.ts'),
      'utf8',
    );
    expect(fireService).toContain("from '../../catalogue/contract'");
    const importLines = fireService
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(
      importLines.some(
        (line) =>
          line.includes('catalogue/menu-items') ||
          line.includes('catalogue/fire-facts'),
      ),
    ).toBe(false);

    // Existing pre-existing deviation is not expanded: still exactly one
    // private inner path, unchanged.
    expect(KNOWN_DEVIATIONS['sales->catalogue']).toEqual([
      'pricing/price-resolution.service',
    ]);
  });

  /**
   * P1E-6 — Organisation Table display fact (FR-KDS-020 dine-in reference).
   * Same P1E-3A pattern; `sales->organisation` did NOT previously appear in
   * `KNOWN_DEVIATIONS` at all — this contract is Sales' first Organisation
   * edge, and it is PUBLIC from the start (no deviation entry is added).
   */
  it('Organisation publishes a public Table-display contract, and Sales consumes only that contract', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'organisation/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './table-display.query'");
    const query = readFileSync(
      join(MODULES_ROOT, 'organisation/contract/table-display.query.ts'),
      'utf8',
    );
    expect(query).toContain('TableDisplayQuery');
    expect(query).not.toMatch(/:\s*any\b|<any>|\bas any\b/);

    const fireService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-fire.service.ts'),
      'utf8',
    );
    expect(fireService).toContain("from '../../organisation/contract'");
    const importLines = fireService
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(
      importLines.some(
        (line) =>
          line.includes('organisation/tables') ||
          line.includes('organisation/station-routing') ||
          line.includes('organisation/stations'),
      ),
    ).toBe(false);

    expect(KNOWN_DEVIATIONS['sales->organisation']).toBeUndefined();
    expect(
      violations.filter(
        (v) => v.importer === 'sales' && v.imported === 'organisation',
      ),
    ).toEqual([]);
  });

  /**
   * P1F-1 — Treasury CashSession facts (P1D-G attribution: branch, employee,
   * shift, drawer, terminal, currency, open status). The FIRST `sales ->
   * treasury` edge, and — same pattern as `sales->organisation` — public
   * from the start, so no deviation entry is added.
   */
  it('Treasury publishes a public CashSession-facts contract, and Sales consumes only that contract', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'treasury/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './cash-session-facts.query'");
    const query = readFileSync(
      join(MODULES_ROOT, 'treasury/contract/cash-session-facts.query.ts'),
      'utf8',
    );
    expect(query).toContain('CashSessionFactsQuery');
    expect(query).not.toMatch(/:\s*any\b|<any>|\bas any\b/);

    const paymentService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-payment.service.ts'),
      'utf8',
    );
    expect(paymentService).toContain("from '../../treasury/contract'");
    const importLines = paymentService
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(
      importLines.some(
        (line) =>
          line.includes('treasury/cash-sessions') ||
          line.includes('treasury/drawers'),
      ),
    ).toBe(false);

    expect(KNOWN_DEVIATIONS['sales->treasury']).toBeUndefined();
    expect(
      violations.filter(
        (v) => v.importer === 'sales' && v.imported === 'treasury',
      ),
    ).toEqual([]);
  });

  /** P1F-1 — same contract-purity guarantee for Treasury's new contract/. */
  it('Treasury contract/ contains interface/types only — no persistence implementation', () => {
    const contractDir = join(MODULES_ROOT, 'treasury/contract');
    const offending = walk(contractDir)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => containsPersistenceImplementation(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULES_ROOT, f));
    expect(offending).toEqual([]);
  });

  it('the concrete CashSessionFactsQuery implementation is private (outside contract/), and Sales never imports it', () => {
    const implementationSource = readFileSync(
      join(
        MODULES_ROOT,
        'treasury/cash-sessions/cash-session-facts.query.service.ts',
      ),
      'utf8',
    );
    expect(containsPersistenceImplementation(implementationSource)).toBe(true);

    const paymentService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-payment.service.ts'),
      'utf8',
    );
    expect(paymentService).not.toContain(
      'treasury/cash-sessions/cash-session-facts.query.service',
    );
    expect(paymentService).not.toContain('CashSessionFactsQueryService');
  });

  /** P1F-1 §25 — zero new deviations for the new CashSession-facts contract. */
  it('Payment adds zero new module-boundary deviations', () => {
    expect(KNOWN_DEVIATIONS['sales->treasury']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['sales->catalogue']).toEqual([
      'pricing/price-resolution.service',
    ]);
    expect(KNOWN_DEVIATIONS['sales->organisation']).toBeUndefined();
  });

  /**
   * P1F-1A — Localisation's FIRST published `contract/`. P1F-1's own
   * reasoning that reusing the pre-existing `sales->localisation` private
   * deviation was "zero new deviation" is REJECTED: an existing
   * private-import deviation is debt, not a public API, and a NEW consumer
   * relying on it expands the violation even when the allow-list key does
   * not change. `SalesPaymentService` now consumes Localisation ONLY
   * through `PINNED_PAYMENT_POLICY_QUERY`.
   */
  it('Localisation publishes a public pinned-payment-policy contract, and SalesPaymentService consumes only that contract', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'localisation/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './pinned-payment-policy.query'");
    const query = readFileSync(
      join(
        MODULES_ROOT,
        'localisation/contract/pinned-payment-policy.query.ts',
      ),
      'utf8',
    );
    expect(query).toContain('PinnedPaymentPolicyQuery');
    expect(query).not.toMatch(/:\s*any\b|<any>|\bas any\b/);

    const paymentService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-payment.service.ts'),
      'utf8',
    );
    expect(paymentService).toContain("from '../../localisation/contract'");
    const importLines = paymentService
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    // SalesPaymentService may not import ANY Localisation internal path —
    // not `country-pack/country-pack.service` (what P1F-1 used), not any
    // other `country-pack/`/`tax/` private path either.
    expect(
      importLines.some(
        (line) =>
          line.includes('localisation/country-pack') ||
          line.includes('localisation/payment-policy') ||
          line.includes('localisation/tax'),
      ),
    ).toBe(false);
    expect(paymentService).not.toContain('CountryPackService');
  });

  /** P1F-1A — same contract-purity guarantee for Localisation's new contract/. */
  it('Localisation contract/ contains interface/types only — no persistence implementation', () => {
    const contractDir = join(MODULES_ROOT, 'localisation/contract');
    const offending = walk(contractDir)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => containsPersistenceImplementation(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULES_ROOT, f));
    expect(offending).toEqual([]);
  });

  it('the concrete PinnedPaymentPolicyQuery implementation is private (outside contract/), and Sales never imports it', () => {
    const implementationSource = readFileSync(
      join(
        MODULES_ROOT,
        'localisation/payment-policy/pinned-payment-policy.query.service.ts',
      ),
      'utf8',
    );
    // Same as every other private query implementation in this suite: the
    // detector's `@Injectable`/`class` checks are a broad "this is a
    // concrete implementation, not a pure interface file" proxy — true
    // here regardless of this adapter delegating to `CountryPackService`
    // rather than querying Prisma directly.
    expect(containsPersistenceImplementation(implementationSource)).toBe(true);

    const paymentService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-payment.service.ts'),
      'utf8',
    );
    expect(paymentService).not.toContain(
      'localisation/payment-policy/pinned-payment-policy.query.service',
    );
    expect(paymentService).not.toContain('PinnedPaymentPolicyQueryService');
  });

  /**
   * P1F-1A — the historical `sales->localisation` deviation
   * (`OrderLinesService`'s own pre-existing, unrepaired use of
   * `CountryPackService`/tax internals) must NOT grow because of Payment,
   * and must NOT be read as blanket permission for a new Sales consumer to
   * reach any Localisation internal path.
   */
  it('Payment does not expand the historical sales->localisation deviation', () => {
    expect(KNOWN_DEVIATIONS['sales->localisation']).toEqual([
      'country-pack/country-pack.registry',
      'country-pack/country-pack.service',
      'tax/tax-class.service',
      'tax/tax-engine.registry',
      'tax/tax.calculator',
      'tax/tax.model',
    ]);
    // None of `sales-payment.service.ts`'s own violations (there should be
    // none) contribute a NEW inner path to that list.
    const paymentViolations = violations.filter(
      (v) =>
        v.importer === 'sales' &&
        v.imported === 'localisation' &&
        v.file.includes('sales-payment.service.ts'),
    );
    expect(paymentViolations).toEqual([]);
  });

  /**
   * P1E-6 §25 — zero new deviations for the two new Fire-facts contracts.
   * The whole-tree "records every pre-existing deviation, and no more" test
   * below already enforces this exactly (any unexpected import fails it),
   * but this assertion names the specific expectation for Fire the way the
   * P1E-5 Kitchen assertions above do for Kitchen.
   */
  it('Fire adds zero new module-boundary deviations', () => {
    expect(KNOWN_DEVIATIONS['sales->catalogue']).toEqual([
      'pricing/price-resolution.service',
    ]);
    expect(KNOWN_DEVIATIONS['sales->organisation']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['kitchen->sales']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['kitchen->catalogue']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['kitchen->organisation']).toBeUndefined();
  });

  /**
   * P1E-1 — the symmetric Kitchen Ops contract for `ticket.bumped`. No
   * `KitchenModule`, `Ticket`, or `TicketLine` exists; only the typed event
   * contract does (see the P1D-1/P1E gate report §I for why Kitchen
   * persistence is not yet source-decidable).
   */
  it('Kitchen Ops publishes a public contract directory (ticket.bumped)', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'kitchen/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './events'");
    const events = readFileSync(
      join(MODULES_ROOT, 'kitchen/contract/events.ts'),
      'utf8',
    );
    expect(events).toContain("'ticket.bumped'");
    expect(events).not.toMatch(/:\s*any\b|<any>|\bas any\b/);
  });

  /**
   * Nothing outside Workforce may reach past `contract/` — stated as a whole-tree
   * assertion rather than a Treasury-only one, so a future consumer inherits the
   * rule without anyone remembering to extend this file.
   */
  it('no module imports a Workforce internal directory', () => {
    expect(violations.filter((v) => v.imported === 'workforce')).toEqual([]);
  });

  /**
   * P1E-3 — FR-KDS-010 resolution reads Organisation-owned routing
   * configuration (`kitchen.station_routing_rules`, `kitchen.branch_kds_config`)
   * ONLY through `organisation/contract`'s `RoutingConfigQuery` (ADR 0008
   * D-07/D-06: Organisation stores the configuration, Kitchen resolves it).
   * Kitchen must not reach `organisation/station-routing/*`,
   * `organisation/stations/*`, or any other private Organisation path.
   */
  it('Organisation publishes routing configuration through contract/ (RoutingConfigQuery)', () => {
    const contract = readFileSync(
      join(MODULES_ROOT, 'organisation/contract/index.ts'),
      'utf8',
    );
    expect(contract).toContain("export * from './routing-config.query'");
    const query = readFileSync(
      join(MODULES_ROOT, 'organisation/contract/routing-config.query.ts'),
      'utf8',
    );
    expect(query).toContain('RoutingConfigQuery');
    expect(query).not.toMatch(/:\s*any\b|<any>|\bas any\b/);
  });

  it("Kitchen resolves FR-KDS-010 using only Organisation's published contract", () => {
    const offending = violations.filter(
      (v) => v.importer === 'kitchen' && v.imported === 'organisation',
    );
    expect(offending).toEqual([]);

    const resolver = readFileSync(
      join(MODULES_ROOT, 'kitchen/routing/routing-resolver.service.ts'),
      'utf8',
    );
    expect(resolver).toContain("from '../../organisation/contract'");
    expect(resolver).not.toContain('organisation/station-routing');
    expect(resolver).not.toContain('organisation/stations');
  });

  it('Kitchen is not a new module-boundary deviation (zero new entries)', () => {
    expect(KNOWN_DEVIATIONS['kitchen->organisation']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['kitchen->sales']).toBeUndefined();
    expect(KNOWN_DEVIATIONS['kitchen->catalogue']).toBeUndefined();
    expect(violations.filter((v) => v.importer === 'kitchen')).toEqual([]);
  });

  /**
   * P1E-3A — CONTRACT PURITY.
   *
   * P1E-3 acceptance review found that `organisation/contract/
   * routing-config.query.ts` contained not just the public interface but the
   * concrete `@Injectable()` Prisma-backed query service — an import-path
   * check alone (the tests above) cannot catch this, because the import path
   * WAS `contract/`; the violation is what the file at that path contains,
   * not where it lives. §5.4: "contract/ is PUBLIC ... application/
   * infrastructure remain PRIVATE."
   *
   * `containsPersistenceImplementation` looks for BEHAVIOUR, not the literal
   * word "Prisma" — a type-only `Prisma.TransactionClient` parameter is the
   * accepted same-transaction contract shape (SRS §5.5.1) and must stay
   * legal. It instead flags: a `class` declaration (the public contract
   * should be interfaces/consts/types only — nothing to `new`), an
   * `@Injectable()` decorator, or a Prisma query-method CALL
   * (`.findMany(`, `.findUnique(`, etc. — an actual query, not a type name).
   */
  function containsPersistenceImplementation(source: string): boolean {
    const QUERY_CALL_RE =
      /\.\s*(findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/;
    return (
      /@Injectable\s*\(/.test(source) ||
      /\bclass\s+\w/.test(source) ||
      QUERY_CALL_RE.test(source)
    );
  }

  it('the persistence-implementation detector fires on a fabricated bad contract, and not on a clean one', () => {
    const fabricatedBadContract = `
      import { Injectable } from '@nestjs/common';
      import { Prisma } from '../../../generated/prisma/client';
      export interface RoutingConfigQuery { find(tx: Prisma.TransactionClient): Promise<unknown>; }
      @Injectable()
      export class RoutingConfigQueryImpl implements RoutingConfigQuery {
        async find(tx: Prisma.TransactionClient) {
          return tx.stationRoutingRule.findMany({ where: {} });
        }
      }
    `;
    expect(containsPersistenceImplementation(fabricatedBadContract)).toBe(true);

    const cleanContractFixture = `
      import { Prisma } from '../../../generated/prisma/client';
      export const ROUTING_CONFIG_QUERY = Symbol('ROUTING_CONFIG_QUERY');
      export interface RoutingConfigQueryInput { readonly tenantId: string; }
      export interface RoutingConfigQuery {
        find(tx: Prisma.TransactionClient, input: RoutingConfigQueryInput): Promise<unknown>;
      }
    `;
    expect(containsPersistenceImplementation(cleanContractFixture)).toBe(false);
  });

  it('Organisation contract/ contains interface/types only — no persistence implementation', () => {
    const contractDir = join(MODULES_ROOT, 'organisation/contract');
    const offending = walk(contractDir)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => containsPersistenceImplementation(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULES_ROOT, f));
    expect(offending).toEqual([]);
  });

  /** P1E-6 — same contract-purity guarantee for Catalogue's new contract/. */
  it('Catalogue contract/ contains interface/types only — no persistence implementation', () => {
    const contractDir = join(MODULES_ROOT, 'catalogue/contract');
    const offending = walk(contractDir)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => containsPersistenceImplementation(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULES_ROOT, f));
    expect(offending).toEqual([]);
  });

  it('the concrete CatalogueFireFactsQuery implementation is private (outside contract/), and Sales never imports it', () => {
    const implementationSource = readFileSync(
      join(
        MODULES_ROOT,
        'catalogue/fire-facts/catalogue-fire-facts.query.service.ts',
      ),
      'utf8',
    );
    expect(containsPersistenceImplementation(implementationSource)).toBe(true);

    const fireService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-fire.service.ts'),
      'utf8',
    );
    expect(fireService).not.toContain('catalogue/fire-facts');
    expect(fireService).not.toContain('CatalogueFireFactsQueryService');
  });

  it('the concrete TableDisplayQuery implementation is private (outside contract/), and Sales never imports it', () => {
    const implementationSource = readFileSync(
      join(MODULES_ROOT, 'organisation/tables/table-display.query.service.ts'),
      'utf8',
    );
    expect(containsPersistenceImplementation(implementationSource)).toBe(true);

    const fireService = readFileSync(
      join(MODULES_ROOT, 'sales/orders/sales-fire.service.ts'),
      'utf8',
    );
    expect(fireService).not.toContain(
      'organisation/tables/table-display.query.service',
    );
    expect(fireService).not.toContain('TableDisplayQueryService');
  });

  it('the concrete RoutingConfigQuery implementation is private (outside contract/), and Kitchen never imports it', () => {
    // Proves the implementation was actually moved, not merely duplicated.
    const implementationSource = readFileSync(
      join(
        MODULES_ROOT,
        'organisation/routing-config/routing-config.query.service.ts',
      ),
      'utf8',
    );
    expect(containsPersistenceImplementation(implementationSource)).toBe(true);

    const resolver = readFileSync(
      join(MODULES_ROOT, 'kitchen/routing/routing-resolver.service.ts'),
      'utf8',
    );
    expect(resolver).not.toContain('organisation/routing-config');
    expect(resolver).not.toContain('RoutingConfigQueryService');
    expect(
      violations.filter(
        (v) =>
          v.importer === 'kitchen' &&
          v.imported === 'organisation' &&
          v.inner.startsWith('routing-config'),
      ),
    ).toEqual([]);
  });

  /**
   * P1E-5 — the transactional Kitchen handler for `order.line.fired`.
   *
   * Kitchen imports Sales ONLY through `sales/contract` (the typed event —
   * `OrderLineFiredEvent`/`ORDER_LINE_FIRED_EVENT_TYPE`), never a Sales
   * private path; it imports NOTHING from Catalogue at all (routing
   * selectors travel in the event payload as plain ids/strings, never a
   * Catalogue Prisma type or service).
   */
  it("Kitchen's order.line.fired handler imports only Sales' published contract, and nothing from Catalogue", () => {
    const salesViolations = violations.filter(
      (v) => v.importer === 'kitchen' && v.imported === 'sales',
    );
    expect(salesViolations).toEqual([]);
    const catalogueViolations = violations.filter(
      (v) => v.importer === 'kitchen' && v.imported === 'catalogue',
    );
    expect(catalogueViolations).toEqual([]);

    const handler = readFileSync(
      join(MODULES_ROOT, 'kitchen/tickets/order-line-fired.handler.ts'),
      'utf8',
    );
    expect(handler).toContain("from '../../sales/contract'");
    // Import-statement shape only — the docblock's own PROSE legitimately
    // discusses "sales.*"/"catalogue.*" tables to explain why none are read.
    const importLines = handler
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines.some((line) => line.includes('sales/orders'))).toBe(
      false,
    );
    expect(importLines.some((line) => line.includes('catalogue'))).toBe(false);
  });

  /**
   * P1E-5 — the handler is PRIVATE: a plain provider in `KitchenModule`,
   * never exported, never imported by anything else in the repository
   * (proven the same way `RoutingConfigQueryService`'s privacy is proven —
   * by showing NO file outside its own module imports it).
   */
  it('OrderLineFiredHandler is private — nothing outside Kitchen imports it', () => {
    const offendingImporters = new Set<string>();
    for (const file of walk(MODULES_ROOT)) {
      if (
        file.includes('/kitchen/') ||
        file.endsWith('module-boundaries.spec.ts')
      ) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      const importsHandler = source
        .split('\n')
        .some(
          (line) =>
            /^\s*import\b/.test(line) && line.includes('OrderLineFiredHandler'),
        );
      if (importsHandler) {
        offendingImporters.add(relative(MODULES_ROOT, file));
      }
    }
    expect([...offendingImporters]).toEqual([]);
  });

  /**
   * P1E-5 §29 items 61/62 — Kitchen must never directly query the Sales
   * tables an event payload already snapshots, nor any Catalogue table.
   * Detects the Prisma delegate CALL shape (a real query), not the mere
   * presence of a relation field name (a composite FK target, legal for
   * integrity) — the same behaviour-not-vocabulary principle as
   * `containsPersistenceImplementation` above.
   */
  function containsForeignPrismaQuery(source: string): boolean {
    const FOREIGN_DELEGATE_CALL_RE =
      /\.(order|orderLine|orderLineModifier|modifier|modifierGroup|menuItem|category)\s*\.\s*(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/;
    return FOREIGN_DELEGATE_CALL_RE.test(source);
  }

  it('the foreign-Prisma-query detector fires on a fabricated Kitchen violation, and not on the real Kitchen source', () => {
    const fabricated = `
      export class BadHandler {
        async handle(event, ctx) {
          const order = await ctx.tx.order.findUnique({ where: { id: event.payload.orderId } });
          return order;
        }
      }
    `;
    expect(containsForeignPrismaQuery(fabricated)).toBe(true);

    const cleanFixture = `
      export class GoodHandler {
        async handle(event, ctx) {
          const ticket = await ctx.tx.ticket.findUnique({ where: { id: event.payload.orderId } });
          return ticket;
        }
      }
    `;
    expect(containsForeignPrismaQuery(cleanFixture)).toBe(false);
  });

  it('Kitchen application code contains no direct Prisma query against Sales or Catalogue tables', () => {
    const kitchenDir = join(MODULES_ROOT, 'kitchen');
    const offending = walk(kitchenDir)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter((f) => containsForeignPrismaQuery(readFileSync(f, 'utf8')))
      .map((f) => relative(MODULES_ROOT, f));
    expect(offending).toEqual([]);
  });

  /**
   * The general rule: every cross-module import is either a published contract
   * or an explicitly recorded pre-existing path.
   */
  it('no module imports another module outside its published contract', () => {
    const unexpected = violations.filter(
      (v) =>
        !(KNOWN_DEVIATIONS[`${v.importer}->${v.imported}`] ?? []).includes(
          v.inner,
        ),
    );
    expect(unexpected).toEqual([]);
  });

  /**
   * The recorded debt must stay debt. When a slice closes one of these edges this
   * test fails and the entry is deleted — which is how the exemption list shrinks
   * instead of ossifying into permission.
   */
  it('records every pre-existing deviation, and no more', () => {
    const actual: Record<string, string[]> = {};
    for (const v of violations) {
      const key = `${v.importer}->${v.imported}`;
      (actual[key] ??= []).push(v.inner);
    }
    for (const key of Object.keys(actual)) {
      actual[key] = [...new Set(actual[key])].sort();
    }
    expect(actual).toEqual(KNOWN_DEVIATIONS);
  });
});
