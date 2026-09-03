import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  AUTHORIZATION_TARGET_KEY,
  type AuthorizationTargetSpec,
} from './identity/contract/authorization-target';
import { PERMISSIONS_KEY } from './identity/authz/decorators/require-permission.decorator';
import type { RequiredPermissions } from './identity/authz/decorators/require-permission.decorator';

/**
 * AUTHORIZATION COVERAGE GATE — B1-3 §7.
 *
 * FR-SEC-004 [M] is a property of EVERY applicable business operation, not of
 * the primitive that decides one. A primitive that is correct and a route that
 * forgets to use it produce exactly the same audit trail as no primitive at
 * all, so the guarantee has to be mechanical.
 *
 * ── WHAT THIS GATE ACTUALLY PROVES ──────────────────────────────────────────
 * It enumerates every HTTP route in the repository FROM THE FILESYSTEM — every
 * `*.controller.ts`, not a hand-kept list — and reads the decorator metadata
 * Nest itself will read at runtime. For each route it requires ONE of:
 *
 *   (a) an `@AuthorizationTarget(...)` declaration, so `PermissionGuard`
 *       evaluates `permission AND target scope`; or
 *   (b) an entry in `REVIEWED_TENANT_TARGET_ROUTES` / `REVIEWED_UNPROTECTED_ROUTES`
 *       below, each naming the route and the reason it is exempt.
 *
 * A NEW controller, or a new route on an existing one, is therefore covered the
 * moment it exists: it cannot ship on the transitional tenant-only guard
 * silently. That is the specific failure this gate exists to prevent — B1-2's
 * ADR 0009 D-10 left a fail-closed but ambient rule, and an ambient rule spreads.
 *
 * ── WHAT IT DOES NOT PROVE, AND MUST NOT BE READ AS PROVING ─────────────────
 * It proves DECLARATION, not correctness of the classification. That a route
 * says `tenantTarget(...)` is checked here; that tenant is the RIGHT target for
 * it is a review judgement, recorded in the B1-3 report's inventory and
 * exercised by `test/scoped-authorization-matrix.e2e-spec.ts`.
 *
 * It is also NOT CI. This branch contains no GitHub pipeline; the suite is
 * executable here and Integration can wire it in. `FR-PLT-013` is not claimed.
 *
 * The allowlists are itemised and asserted to be LIVE: a stale entry fails the
 * suite, so the exemption list can shrink and cannot quietly rot.
 */

const MODULES_ROOT = resolve(__dirname);
const SRC_ROOT = resolve(__dirname, '..');

/**
 * TRUE TENANT-TARGET / AUTH-ONLY routes that carry a permission but deliberately
 * declare no `@AuthorizationTarget`.
 *
 * B1-3 converted every one of these to an explicit `tenantTarget(...)` instead,
 * because an explicit tenant target and an undeclared one differ in exactly the
 * way that matters: the explicit one is reviewable. The list is therefore EMPTY,
 * and the mechanism is kept because the next slice to add a genuinely
 * tenant-only route should have to write down why rather than say nothing.
 */
const REVIEWED_TENANT_TARGET_ROUTES: Readonly<Record<string, string>> = {};

/**
 * Routes with NO `@RequirePermission` at all.
 *
 * Each is authentication/identity plumbing or an unauthenticated entry point,
 * and each is listed with the reason it has no narrower business target. A
 * route that acquires a business target later must move off this list — which
 * is what the "stale entry" assertion below enforces.
 */
const REVIEWED_UNPROTECTED_ROUTES: Readonly<Record<string, string>> = {
  'GET /health':
    'Liveness probe. Unauthenticated by design; discloses no tenant data.',
  'POST /auth/login':
    'Unauthenticated entry point — it is what ESTABLISHES a principal.',
  'POST /auth/pin':
    'FR-SEC-021 PIN sign-in. Unauthenticated in the RBAC sense; the terminal + employee code + PIN are the credential.',
  'POST /auth/refresh':
    'Refresh-token exchange. Authority is the refresh token itself; it mints a token, it does not act on a business resource.',
  'POST /auth/logout':
    'Ends the caller’s own session. The only resource is the session the caller already holds.',
  'GET /auth/me': 'The caller’s own identity. No target but the caller.',
  'GET /auth/permissions':
    'The caller’s OWN effective scope (FR-SEC-045). Reading one’s own authority cannot be gated on holding authority.',
  'POST /auth/password/change':
    'The caller changes their OWN password (FR-SEC-005 lifecycle, ADR 0005).',
  'POST /auth/password/forgot':
    'Unauthenticated password-reset request; deliberately non-enumerating.',
  'POST /auth/password/reset':
    'Unauthenticated reset redemption; the reset token is the credential.',
  'GET /auth/tenants':
    'Lists the memberships the AUTHENTICATED USER already holds, before any tenant is selected. There is no tenant context yet to scope against.',
  'POST /auth/tenant':
    'Selects one of the caller’s own memberships and mints a tenant-bound token. Authority is the membership itself.',
  'GET /auth/tenant': 'Reads the caller’s own selected tenant context.',
  'POST /auth/terminal':
    'Binds the caller’s session to a terminal (ADR 0004). The terminal credential is the authority; TenantContextService then derives the operating branch live.',
  'GET /auth/terminal': 'Reads the caller’s own bound terminal.',
  'POST /sync/batch':
    'Offline sync transport authenticated by tenant-bound terminal/session ' +
    'guards; branch is server-derived; operation-level domain authorization ' +
    'is delegated to SYNC_AUTHORIZATION_PORT when production handlers are ' +
    'added.',
  'POST /sync/recovery/:grantId/batch':
    'D4-1B lossless revoked-terminal recovery upload. Authenticated as an ' +
    'ADMIN (JwtAuthGuard + TenantContextGuard only — never the revoked ' +
    'terminal itself; PinService.authenticate refuses a non-active terminal ' +
    'outright, so a terminal-authenticated route would be unreachable in ' +
    'exactly the case it exists for — see SyncRecoveryService’s docblock). ' +
    'No static @AuthorizationTarget is possible because the target branch ' +
    'is only known once the :grantId row is loaded; ' +
    'SyncRecoveryService.authorizeGrantForBatch instead calls the SAME ' +
    'SCOPE_AUTHORIZATION.assertAuthorized primitive PermissionGuard uses, ' +
    'programmatically, against the grant’s own recorded branch, requiring ' +
    'live identity.terminal.manage (the SAME permission that gates grant ' +
    'issuance, POST /sync/recovery/grants). Operation-level domain ' +
    'authorization inside the batch is the same SYNC_AUTHORIZATION_PORT ' +
    'every production handler already enforces.',
};

// ───────────────────────────────────────────────────────── route discovery ──

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

interface RouteRecord {
  readonly id: string;
  readonly file: string;
  readonly controller: string;
  readonly handler: string;
  readonly permissions: RequiredPermissions | undefined;
  readonly target: AuthorizationTargetSpec | undefined;
}

function joinPath(base: unknown, sub: unknown): string {
  const b = typeof base === 'string' ? base : '';
  const s = typeof sub === 'string' ? sub : '';
  const parts = [b, s]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

function collectRoutes(): RouteRecord[] {
  const routes: RouteRecord[] = [];
  const files = [...walk(MODULES_ROOT), ...walk(resolve(SRC_ROOT, 'health'))];

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controllerPath: unknown = Reflect.getMetadata(
        PATH_METADATA,
        exported,
      );
      if (controllerPath === undefined) continue;

      const proto = (exported as { prototype: object }).prototype;
      const classPermissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        exported,
      ) as RequiredPermissions | undefined;
      const classTarget = Reflect.getMetadata(
        AUTHORIZATION_TARGET_KEY,
        exported,
      ) as AuthorizationTargetSpec | undefined;

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;

        const verb =
          METHOD_NAMES[method as number] ??
          (typeof method === 'number' ? String(method) : 'UNKNOWN');
        const path = joinPath(
          controllerPath,
          Reflect.getMetadata(PATH_METADATA, handler),
        );
        routes.push({
          id: `${verb} ${path}`,
          file: relative(SRC_ROOT, file),
          controller: exported.name,
          handler: name,
          permissions:
            (Reflect.getMetadata(PERMISSIONS_KEY, handler) as
              RequiredPermissions | undefined) ?? classPermissions,
          target:
            (Reflect.getMetadata(AUTHORIZATION_TARGET_KEY, handler) as
              AuthorizationTargetSpec | undefined) ?? classTarget,
        });
      }
    }
  }
  return routes.sort((a, b) => a.id.localeCompare(b.id));
}

// ────────────────────────────────────────────────────────────────── the gate ──

describe('Authorization coverage gate (B1-3)', () => {
  const routes = collectRoutes();

  it('discovers the HTTP surface from the filesystem, not from a fixed list', () => {
    // A sanity floor: if discovery silently stopped working, every assertion
    // below would pass vacuously. This is the tripwire for that.
    expect(routes.length).toBeGreaterThan(120);
    expect(new Set(routes.map((r) => r.file)).size).toBeGreaterThanOrEqual(15);
  });

  it('route ids are unique, so no route can hide behind another', () => {
    const seen = new Map<string, RouteRecord[]>();
    for (const route of routes) {
      seen.set(route.id, [...(seen.get(route.id) ?? []), route]);
    }
    const duplicates = [...seen.entries()]
      .filter(([, rs]) => rs.length > 1)
      .map(([id, rs]) => `${id} -> ${rs.map((r) => r.handler).join(', ')}`);
    expect(duplicates).toEqual([]);
  });

  it('EVERY permission-bearing route declares an explicit authorization target', () => {
    const undeclared = routes
      .filter((r) => r.permissions !== undefined && r.target === undefined)
      .filter((r) => !(r.id in REVIEWED_TENANT_TARGET_ROUTES))
      .map((r) => `${r.id}  (${r.file}#${r.handler})`);

    // Failing message is the whole point: it tells the next author exactly what
    // to add, and that adding nothing is not an option.
    expect(undeclared).toEqual([]);
  });

  it('EVERY route without a permission requirement is a reviewed auth-only route', () => {
    const unlisted = routes
      .filter((r) => r.permissions === undefined)
      .filter((r) => !(r.id in REVIEWED_UNPROTECTED_ROUTES))
      .map((r) => `${r.id}  (${r.file}#${r.handler})`);
    expect(unlisted).toEqual([]);
  });

  it('no allowlist entry is stale', () => {
    const ids = new Set(routes.map((r) => r.id));
    const staleTenant = Object.keys(REVIEWED_TENANT_TARGET_ROUTES).filter(
      (id) => !ids.has(id),
    );
    const staleUnprotected = Object.keys(REVIEWED_UNPROTECTED_ROUTES).filter(
      (id) => !ids.has(id),
    );
    expect({ staleTenant, staleUnprotected }).toEqual({
      staleTenant: [],
      staleUnprotected: [],
    });
  });

  it('every allowlist entry states a reason', () => {
    const blank = [
      ...Object.entries(REVIEWED_TENANT_TARGET_ROUTES),
      ...Object.entries(REVIEWED_UNPROTECTED_ROUTES),
    ]
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([id]) => id);
    expect(blank).toEqual([]);
  });

  it('every declared target is structurally valid', () => {
    const invalid: string[] = [];
    for (const route of routes) {
      const spec = route.target;
      if (!spec) continue;
      switch (spec.kind) {
        case 'tenant':
        case 'authOnly':
          // A bare classification with no stated reason is exactly the kind of
          // "tenant because it was easier" the review has to be able to catch.
          if (spec.reason.trim().length < 20) invalid.push(route.id);
          break;
        case 'branch':
          if (!spec.key) invalid.push(route.id);
          // A T-12 exemption without a written reason is exactly the kind of
          // quiet opt-out the correction exists to prevent.
          if (
            spec.allowInactive !== undefined &&
            spec.allowInactive.reason.trim().length < 40
          ) {
            invalid.push(route.id);
          }
          break;
        case 'brand':
        case 'branchOrTenant':
          if (!spec.key) invalid.push(route.id);
          break;
        case 'requestBranch':
          if (!spec.property || !spec.key) invalid.push(route.id);
          break;
        case 'declaredScope':
          if (!spec.typeKey || !spec.brandKey || !spec.branchKey) {
            invalid.push(route.id);
          }
          break;
        case 'resource':
        case 'resourceOrTenant':
          if (
            typeof spec.token !== 'symbol' ||
            Object.keys(spec.keys).length === 0 ||
            spec.description.trim().length < 20 ||
            // The tenant-safe 404 wording is load-bearing: it is what the guard
            // raises INSTEAD of letting an unresolvable resource reach the
            // handler, so a missing one would reintroduce the defer hole.
            spec.notFound.trim().length === 0
          ) {
            invalid.push(route.id);
          }
          break;
        case 'posTerminalBranch':
        case 'sessionTerminalBranch':
          break;
      }
    }
    expect(invalid).toEqual([]);
  });

  it('the T-12 inactive-branch exemption is used by exactly the branch lifecycle route', () => {
    // A census, not a spot check. T-12 denies every scope on a non-active
    // branch; the ONLY route allowed to opt out is the one that reactivates it.
    // If a future slice adds a second exemption, this fails and that exemption
    // gets argued for explicitly instead of appearing in a diff.
    const exempt = routes
      .filter((r) => r.target?.kind === 'branch' && r.target.allowInactive)
      .map((r) => r.id);
    expect(exempt).toEqual(['POST /org/branches/:branchId/status']);
  });

  it('reports the target classification totals (evidence for the B1-3 report)', () => {
    const totals: Record<string, number> = {};
    for (const route of routes) {
      const kind = route.target?.kind ?? 'UNDECLARED';
      totals[kind] = (totals[kind] ?? 0) + 1;
    }

    console.log('B1-3 authorization target totals:', {
      routes: routes.length,
      ...totals,
    });
    expect(totals.UNDECLARED ?? 0).toBe(
      Object.keys(REVIEWED_UNPROTECTED_ROUTES).length +
        Object.keys(REVIEWED_TENANT_TARGET_ROUTES).length,
    );
  });
});
