import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { TargetScope } from '../authz/scope';

/**
 * B1-3 — EXPLICIT TARGET SCOPE FOR EVERY PROTECTED BUSINESS OPERATION.
 *
 * Authority: `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, "AMENDMENT —
 * D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC" (RATIFIED 2026-09-02), and
 * `docs/adr/0009-scoped-rbac.md` D-03 / D-10.
 *
 * ── WHY THIS LIVES IN `contract/` ───────────────────────────────────────────
 * SRS §5.4: `contract/` is a module's PUBLIC surface, and it is the only place
 * another module may import from. Every HTTP module in this repository must
 * declare a target scope on every protected route, so the declaration itself is
 * a published Identity contract — not a private Identity detail. Putting it
 * here is what keeps `module-boundaries.spec.ts`'s `KNOWN_DEVIATIONS` from
 * growing by one entry per module.
 *
 * ── THE RULE B1-2 LEFT IN PLACE, AND WHAT B1-3 REPLACES IT WITH ─────────────
 * ADR 0009 D-10: an operation carrying `@RequirePermission(P)` and NO explicit
 * target scope is a TENANT-target operation, and `RequestAuthorization.
 * permissions` therefore holds ONLY tenant-scoped permissions. That is
 * fail-closed but it is transitional: a BRANCH-scoped grant satisfies nothing.
 *
 * B1-3 attaches an explicit target to every applicable operation.
 * `PermissionGuard` — the SINGLE enforcement point — then evaluates
 * `permission AND target scope` through `ScopeAuthorizationService`. A route
 * that still carries no target keeps the transitional tenant-only behaviour,
 * and `authorization-coverage.spec.ts` fails the build unless that route is on
 * a reviewed, itemised allowlist.
 *
 * ── THE TARGET IS DERIVED FROM THE RESOURCE, NEVER FROM THE PERMISSION ──────
 * Clause 20 / ADR 0009 D-03: SRS Appendix C is absent, so no tenant-only or
 * branch-only classification of the permission catalogue may be invented. Every
 * spec below names where the TARGET RESOURCE's scope comes from, and every
 * source is a trusted server fact: a route parameter resolved tenant-safely, a
 * body field resolved tenant-safely, live terminal state, or the resource row
 * itself. A client-supplied id is never believed on its own — it is resolved
 * inside the caller's RLS context first, and anything invisible in the acting
 * tenant is refused exactly as a non-existent id is (R-4, no existence oracle).
 */

/** Where a raw id is read from on the request. */
export type TargetIdSource = 'param' | 'body' | 'query';

/**
 * How one protected operation's TARGET SCOPE is determined.
 *
 * Every variant carries a `reason` or is self-describing, because the security
 * review has to be able to read the classification without reading the handler.
 */
export type AuthorizationTargetSpec =
  /**
   * A genuinely tenant-wide operation: the resource it acts on is owned by the
   * tenant and has no narrower owner (tenant master data, tenant-level
   * registries, identity/role administration).
   *
   * A BRAND- or BRANCH-scoped grant NEVER satisfies this (upward leakage is
   * denied by the lattice), which is the whole point of stating it explicitly
   * rather than leaving the route undeclared.
   */
  | { readonly kind: 'tenant'; readonly reason: string }
  /** BRANCH target, from an id on the request, resolved tenant-safely. */
  | {
      readonly kind: 'branch';
      readonly source: TargetIdSource;
      readonly key: string;
      /**
       * T-12 EXEMPTION. A branch that is not `active` is denied for EVERY scope
       * (see `AuthorizationTargetResolver`), which would strand a deactivated
       * branch permanently: the operation that reactivates it addresses that
       * same branch. A route may opt out ONLY when it IS the branch's lifecycle
       * administration, and only with a written reason — the coverage gate
       * asserts the reason exists.
       */
      readonly allowInactive?: { readonly reason: string };
    }
  /** BRAND target, from an id on the request, resolved tenant-safely. */
  | {
      readonly kind: 'brand';
      readonly source: TargetIdSource;
      readonly key: string;
    }
  /**
   * BRANCH target when the id is supplied, TENANT target when it is not.
   *
   * For collection reads whose natural unfiltered form spans the whole tenant.
   * Omitting the filter is a TENANT-target request and a narrow grant is
   * correctly refused — it is NOT silently narrowed to the actor's own branch,
   * because silently changing what a request means is how a caller ends up
   * believing it saw everything.
   */
  | {
      readonly kind: 'branchOrTenant';
      readonly source: TargetIdSource;
      readonly key: string;
    }
  /**
   * BRANCH target = the POS session's operating branch, derived live from
   * `identity.terminals` by `TenantContextService` on THIS request. Never from
   * a body, never from a JWT claim (ADR 0009 D-07).
   */
  | { readonly kind: 'posTerminalBranch' }
  /**
   * BRANCH target = the branch of the TERMINAL this session is bound to, read
   * live from `identity.terminals` on this request.
   *
   * Broader than `posTerminalBranch` and deliberately so: a route that requires
   * a terminal-bound session is not necessarily reachable only by a PIN-issued
   * `pos` session, and `TenantContext.branchId` is populated for `pos` sessions
   * ONLY (ADR 0009 D-07). Opening an order is the worked example — it demands
   * `principal.terminalId` but accepts a terminal-bound session that supplies
   * its own `openedByEmployeeId`.
   *
   * For a `pos` session this is exactly the already-live-verified
   * `TenantContext.branchId`; for any other terminal-bound session the terminal
   * row is read tenant-safely and must still be `active`. Either way the branch
   * comes from server state, never from the request.
   */
  | { readonly kind: 'sessionTerminalBranch' }
  /**
   * BRANCH target = a branch id an EARLIER guard already derived from trusted
   * server state and attached to the request (e.g. `KdsStationGuard`'s
   * station binding). Never a client-supplied value.
   */
  | {
      readonly kind: 'requestBranch';
      readonly property: string;
      readonly key: string;
    }
  /**
   * RESOURCE-DERIVED target: load the addressed resource tenant-safely and
   * take its real owning scope. This is the case the brief calls out as a hard
   * acceptance gate — operations whose branch is NOT in the route.
   *
   * `token` names a `ScopeTargetResolver` provider published by the module that
   * OWNS the resource; the guard obtains it by token, so no module reaches into
   * another module's private path.
   */
  | {
      readonly kind: 'resource';
      readonly token: symbol;
      readonly keys: Readonly<Record<string, ResolverKeySpec>>;
      readonly description: string;
      /**
       * The tenant-safe 404 message this route ALREADY returns for a resource
       * that is not visible. The guard raises it itself so the operation never
       * runs unscoped, and it must be the route's own wording so that foreign
       * and non-existent stay byte-identical to each other AND to what the
       * handler would have said.
       */
      readonly notFound: string;
    }
  /**
   * RESOURCE-DERIVED when the resource is named, TENANT when it is not.
   *
   * The `branchOrTenant` idea applied to a filter that names a RESOURCE rather
   * than a branch — an inventory location filter, for instance. Omitting the
   * filter asks a genuinely tenant-wide question and is authorized as one; it is
   * never silently narrowed to whatever the caller happens to hold.
   */
  | {
      readonly kind: 'resourceOrTenant';
      readonly token: symbol;
      readonly keys: Readonly<Record<string, ResolverKeySpec>>;
      readonly description: string;
      readonly notFound: string;
    }
  /**
   * The scope the request itself DECLARES for a resource it is creating.
   *
   * Some resources carry their own scope column — `catalogue.price_lists`
   * (`scope_type` + `scope_id`) and `production.recipes` (`scope` + `brand_id` /
   * `branch_id`) both do. On a CREATE there is no row to read yet, so the target
   * is the scope the caller is asking to create AT, and the caller must hold
   * authority there.
   *
   * That is the opposite of trusting the body: a caller declaring
   * `scope: branch, branchId: B` is not asserting authority over B, it is being
   * REQUIRED to have it. The declared branch/brand id is still resolved against
   * Organisation, so one belonging to another tenant is refused exactly as a
   * non-existent one is.
   */
  | {
      readonly kind: 'declaredScope';
      readonly source: TargetIdSource;
      readonly typeKey: string;
      readonly brandKey: string;
      readonly branchKey: string;
    }
  /**
   * An authenticated operation with NO narrower business target — identity of
   * the caller itself, session lifecycle, and the like.
   *
   * Distinct from `tenant` so the review can tell "this acts on the tenant" from
   * "this acts on nothing the lattice can scope". Enforced identically to
   * `tenant`, because a tenant-bound request is still tenant-bound.
   */
  | { readonly kind: 'authOnly'; readonly reason: string };

/**
 * The lexical shape a raw request value must have before it is allowed to reach
 * a database lookup.
 *
 * This is NOT input validation for its own sake. The guard runs BEFORE Nest's
 * `ValidationPipe`, so a malformed id would otherwise reach Prisma from the
 * guard and turn a route's existing `400` into a `500`. A value of the wrong
 * shape can never identify a real resource, so the guard hands it back to the
 * route's own validation instead of guessing at a target — see
 * `AuthorizationTargetResolver`.
 */
export type TargetIdFormat = 'uuid' | 'businessDay';

/** Where one resolver input id is read from. */
export interface ResolverKeySpec {
  readonly source: TargetIdSource;
  readonly key: string;
  /** Defaults to `uuid`. */
  readonly format?: TargetIdFormat;
  /** A key the resolver can work without (e.g. an optional discriminator). */
  readonly optional?: boolean;
}

export const AUTHORIZATION_TARGET_KEY = 'ros:authorization_target';

/**
 * Declare how this operation's target scope is derived.
 *
 * Placed on a handler, or on a controller class when every route in it shares
 * one target shape. A handler-level declaration overrides the class.
 */
export const AuthorizationTarget = (
  spec: AuthorizationTargetSpec,
): CustomDecorator => SetMetadata(AUTHORIZATION_TARGET_KEY, spec);

// ─────────────────────────────────────────────────────────── spec builders ──
// Named builders rather than raw object literals at ~150 call sites: the
// classification is the security-relevant fact, and it should read as one word
// at the route.

export const tenantTarget = (reason: string): AuthorizationTargetSpec => ({
  kind: 'tenant',
  reason,
});

export const authOnlyTarget = (reason: string): AuthorizationTargetSpec => ({
  kind: 'authOnly',
  reason,
});

export const branchFromParam = (
  key = 'branchId',
  allowInactive?: { readonly reason: string },
): AuthorizationTargetSpec => ({
  kind: 'branch',
  source: 'param',
  key,
  ...(allowInactive ? { allowInactive } : {}),
});

export const branchFromBody = (key = 'branchId'): AuthorizationTargetSpec => ({
  kind: 'branch',
  source: 'body',
  key,
});

export const brandFromParam = (key = 'brandId'): AuthorizationTargetSpec => ({
  kind: 'brand',
  source: 'param',
  key,
});

export const brandFromBody = (key = 'brandId'): AuthorizationTargetSpec => ({
  kind: 'brand',
  source: 'body',
  key,
});

/**
 * BRANCH when the body names one, TENANT when it does not.
 *
 * For a resource whose own branch column is nullable and where NULL genuinely
 * means "every branch" — `catalogue.availability_rules.branch_id` is the worked
 * example (FR-MNU-030: "NULL = applies to all branches"). Creating the
 * tenant-wide form is therefore a TENANT-target operation, which is exactly
 * what stops a single-branch actor from 86-ing an item across the whole tenant.
 */
export const branchFromBodyOrTenant = (
  key = 'branchId',
): AuthorizationTargetSpec => ({
  kind: 'branchOrTenant',
  source: 'body',
  key,
});

export const declaredScopeFromBody = (
  typeKey: string,
  brandKey: string,
  branchKey: string,
): AuthorizationTargetSpec => ({
  kind: 'declaredScope',
  source: 'body',
  typeKey,
  brandKey,
  branchKey,
});

export const branchFromQueryOrTenant = (
  key = 'branchId',
): AuthorizationTargetSpec => ({
  kind: 'branchOrTenant',
  source: 'query',
  key,
});

export const posTerminalBranchTarget = (): AuthorizationTargetSpec => ({
  kind: 'posTerminalBranch',
});

export const sessionTerminalBranchTarget = (): AuthorizationTargetSpec => ({
  kind: 'sessionTerminalBranch',
});

export const requestBranchTarget = (
  property: string,
  key = 'branchId',
): AuthorizationTargetSpec => ({ kind: 'requestBranch', property, key });

export const resourceTarget = (
  token: symbol,
  keys: Readonly<Record<string, ResolverKeySpec>>,
  description: string,
  notFound: string,
): AuthorizationTargetSpec => ({
  kind: 'resource',
  token,
  keys,
  description,
  notFound,
});

export const resourceOrTenantTarget = (
  token: symbol,
  keys: Readonly<Record<string, ResolverKeySpec>>,
  description: string,
  notFound: string,
): AuthorizationTargetSpec => ({
  kind: 'resourceOrTenant',
  token,
  keys,
  description,
  notFound,
});

/** Shorthand for the overwhelmingly common `:id`-style resolver input. */
export const fromParam = (key: string): ResolverKeySpec => ({
  source: 'param',
  key,
});
export const fromBody = (key: string): ResolverKeySpec => ({
  source: 'body',
  key,
});
export const fromQuery = (key: string, optional = false): ResolverKeySpec => ({
  source: 'query',
  key,
  ...(optional ? { optional: true } : {}),
});
/** A `YYYY-MM-DD` business-day path segment, not a uuid. */
export const businessDayFromParam = (key: string): ResolverKeySpec => ({
  source: 'param',
  key,
  format: 'businessDay',
});

// ───────────────────────────────────────────────────────────────── resolver ──

export interface ScopeTargetResolverInput {
  readonly tenantId: string;
  /** Raw ids pulled from the request, already checked to be UUID-shaped. */
  readonly keys: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves the REAL owning scope of an addressed business resource.
 *
 * Implemented by the module that owns the resource, bound to the token the
 * route names. It runs inside the caller's own RLS transaction, so a resource
 * belonging to another tenant is simply invisible.
 *
 * Contract:
 *   - return the resource's actual target scope; or
 *   - return `null` when the resource is NOT VISIBLE in this tenant — which
 *     covers "belongs to another tenant" and "does not exist" identically. The
 *     guard then defers to the route's own tenant-safe 404 (brief §6): a target
 *     must never become an existence oracle, and the 404 the repository already
 *     returns is the non-revealing answer.
 *
 * A resolver MUST NOT widen: if it cannot establish the owning branch/brand of
 * a resource that has one, it returns `null` rather than a TENANT target.
 */
export interface ScopeTargetResolver {
  resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null>;
}

/**
 * The generic `permission + target scope` primitive, published so a module can
 * make a SECOND, in-transaction authorization decision that the route-level
 * guard cannot express — an approver who is a different actor than the caller,
 * or a check that must be atomic with the write it protects.
 *
 * It is the same service the guard uses. There is one lattice, one primitive,
 * one place non-leakage is decided.
 */
export const SCOPE_AUTHORIZATION = Symbol('SCOPE_AUTHORIZATION');

export interface ScopeAuthorizationPort {
  isAuthorized(
    auth: ScopeAuthorizationActor,
    required: {
      readonly codes: readonly string[];
      readonly mode: 'all' | 'any';
    },
    target: TargetScope,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean>;
  assertAuthorized(
    auth: ScopeAuthorizationActor,
    required: {
      readonly codes: readonly string[];
      readonly mode: 'all' | 'any';
    },
    target: TargetScope,
    tx?: Prisma.TransactionClient,
  ): Promise<void>;
}

/**
 * The actor half of an authorization decision. Structurally the
 * `RequestAuthorization` the request already carries — named separately so a
 * consumer module depends on this contract rather than on Identity's internal
 * context type.
 */
export type ScopeAuthorizationActor = Parameters<
  import('../authz/scope-authorization.service').ScopeAuthorizationService['isAuthorized']
>[0];

/**
 * Identity's own resource-derived target: a terminal addressed by its own id.
 * `identity.terminals.branch_id` is NOT NULL, so a terminal always has a real
 * owning branch.
 */
export const IDENTITY_TERMINAL_TARGET_RESOLVER = Symbol(
  'IDENTITY_TERMINAL_TARGET_RESOLVER',
);

export type { TargetScope };
