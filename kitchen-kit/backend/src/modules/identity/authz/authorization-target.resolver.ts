import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BRANCH_BRAND_QUERY,
  type BranchBrandQuery,
} from '../../organisation/contract';
import {
  type AuthorizationTargetSpec,
  type ResolverKeySpec,
  type ScopeTargetResolver,
  type TargetIdFormat,
  type TargetIdSource,
} from '../contract/authorization-target';
import type { RequestAuthorization } from '../context/tenant-context';
import type { TargetScope } from './scope';

/**
 * The outcome of turning a request plus a declared spec into a TARGET SCOPE.
 *
 * `defer` exists for exactly one situation and must not grow: the raw id on the
 * request is not even the right SHAPE to be a resource id. Such a value cannot
 * identify anything, so no authority can be exercised with it, and the route's
 * own `ValidationPipe` (which runs after guards) returns the `400` it always
 * returned. Deciding `deny` there would silently convert every malformed-input
 * `400` in the repository into a `403`.
 */
export type TargetResolution =
  | { readonly outcome: 'target'; readonly target: TargetScope }
  | { readonly outcome: 'deny'; readonly reason: string }
  | { readonly outcome: 'defer'; readonly reason: string };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BUSINESS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function hasShape(value: string, format: TargetIdFormat): boolean {
  return format === 'businessDay'
    ? BUSINESS_DAY_RE.test(value)
    : UUID_RE.test(value);
}

/** A request-scoped bag of raw values, read WITHOUT trusting any of them. */
interface RawRequest {
  readonly params: Record<string, unknown>;
  readonly body: Record<string, unknown>;
  readonly query: Record<string, unknown>;
}

function readRaw(
  req: RawRequest,
  source: TargetIdSource,
  key: string,
): string | undefined {
  const bag =
    source === 'param' ? req.params : source === 'body' ? req.body : req.query;
  const value = bag?.[key];
  // Only a plain string is ever accepted. An array (`?branchId=a&branchId=b`)
  // or an object is a client trying to make the target ambiguous, and
  // ambiguity must never resolve in the caller's favour.
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns a route's declared `AuthorizationTargetSpec` into the concrete
 * `TargetScope` the authorization primitive decides against.
 *
 * ── EVERY TARGET COMES FROM A TRUSTED SERVER FACT ───────────────────────────
 * A client-supplied id is never believed on its own. `branch`/`brand` ids are
 * handed to `ScopeAuthorizationService`, which resolves them against
 * Organisation inside the caller's RLS context and refuses anything invisible
 * in the acting tenant — indistinguishably from an id that does not exist.
 * `resource` targets are resolved by loading the addressed row tenant-safely and
 * reading its REAL owning scope, so a body or path id can only ever select a
 * resource, never assert its scope.
 */
@Injectable()
export class AuthorizationTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
  ) {}

  /**
   * Resolve a client-supplied branch/brand id INSIDE the caller's RLS context,
   * and hand back a target only if it is visible in the acting tenant.
   *
   * ── WHY AN INVISIBLE TARGET DEFERS RATHER THAN DENYING ─────────────────────
   * An id belonging to another tenant, and an id belonging to nobody, are the
   * same thing to this layer — both invisible. The repository already has one
   * answer for that pair, used everywhere and documented on every route: the
   * tenant-safe `404`, byte-identical for both (`assertBranchInScope`, ADR 0008).
   *
   * Answering `403` here instead would not leak anything on its own, but it
   * would replace that single established answer with a second one produced by a
   * different layer — and the moment two layers answer the same question
   * differently, the difference between them becomes the signal. Deferring keeps
   * exactly one answer in the system.
   *
   * It is not a hole: the route's own lookup is what runs next, it is tenant-safe,
   * and it refuses. `ScopeAuthorizationService` independently refuses an
   * invisible target too (B1-2 §14), so the primitive stays strict for every
   * caller that reaches it directly.
   */
  private async resolveVisibleScope(
    auth: RequestAuthorization,
    kind: 'branch' | 'brand',
    id: string,
  ): Promise<TargetResolution> {
    return this.prisma.withAuthContext(
      { userId: auth.context.userId, tenantId: auth.context.tenantId },
      async (tx): Promise<TargetResolution> => {
        if (kind === 'brand') {
          const visible = await this.branchBrand.brandIsVisible(tx, id);
          return visible
            ? { outcome: 'target', target: { type: 'brand', brandId: id } }
            : { outcome: 'defer', reason: 'brand not visible in this tenant' };
        }
        const brandId = await this.branchBrand.findBrandOfBranch(tx, id);
        return brandId === null
          ? { outcome: 'defer', reason: 'branch not visible in this tenant' }
          : {
              // The same query that established visibility yields the parent
              // brand, so the primitive never has to make a second round trip.
              outcome: 'target',
              target: { type: 'branch', branchId: id, brandId },
            };
      },
    );
  }

  async resolve(
    request: Request,
    auth: RequestAuthorization,
    spec: AuthorizationTargetSpec,
  ): Promise<TargetResolution> {
    const raw: RawRequest = {
      params: (request.params ?? {}) as Record<string, unknown>,
      body: (request.body ?? {}) as Record<string, unknown>,
      query: (request.query ?? {}) as Record<string, unknown>,
    };

    switch (spec.kind) {
      case 'tenant':
      case 'authOnly':
        return { outcome: 'target', target: { type: 'tenant' } };

      case 'branch':
      case 'brand': {
        const value = readRaw(raw, spec.source, spec.key);
        if (value === undefined) {
          // A declared target that is simply ABSENT is a refusal, not a
          // fallback. Falling back to a tenant target here would let a caller
          // widen its own target by omitting a field.
          return {
            outcome: 'deny',
            reason: `${spec.kind} target '${spec.key}' absent`,
          };
        }
        if (!hasShape(value, 'uuid')) {
          return { outcome: 'defer', reason: `${spec.key} is not a uuid` };
        }
        return this.resolveVisibleScope(auth, spec.kind, value);
      }

      case 'branchOrTenant': {
        const value = readRaw(raw, spec.source, spec.key);
        if (value === undefined) {
          // Unfiltered collection read = a genuinely tenant-wide request.
          return { outcome: 'target', target: { type: 'tenant' } };
        }
        if (!hasShape(value, 'uuid')) {
          return { outcome: 'defer', reason: `${spec.key} is not a uuid` };
        }
        return this.resolveVisibleScope(auth, 'branch', value);
      }

      case 'declaredScope': {
        const declared = readRaw(raw, spec.source, spec.typeKey);
        if (declared === undefined) {
          return { outcome: 'deny', reason: `'${spec.typeKey}' absent` };
        }
        if (declared === 'tenant') {
          return { outcome: 'target', target: { type: 'tenant' } };
        }
        if (declared !== 'brand' && declared !== 'branch') {
          // Not a scope this system knows. The route's own enum validation
          // returns its 400; nothing can be authorized against a scope that
          // does not exist.
          return { outcome: 'defer', reason: `unknown scope '${declared}'` };
        }
        const key = declared === 'brand' ? spec.brandKey : spec.branchKey;
        const value = readRaw(raw, spec.source, key);
        if (value === undefined) {
          // A `brand`/`branch` scope declared with no id is MALFORMED, and every
          // route that accepts a declared scope rejects that combination with a
          // 400 of its own (`ck_recipe_scope` / D-17-03 for recipes, "Invalid
          // scopeId for the given scopeType" for price lists). The row cannot be
          // created without the id, so deferring authorizes nothing — and it
          // keeps the malformed-input answer a 400 rather than turning it into a
          // 403 that would tell the caller nothing useful.
          return { outcome: 'defer', reason: `'${key}' absent for ${declared}` };
        }
        if (!hasShape(value, 'uuid')) {
          return { outcome: 'defer', reason: `${key} is not a uuid` };
        }
        return this.resolveVisibleScope(auth, declared, value);
      }

      case 'posTerminalBranch': {
        // Populated by TenantContextService from LIVE `identity.terminals`
        // state on this request, for `pos` sessions only. Absent means this is
        // not a POS session, and a route that declares this target has no other
        // meaning — refuse.
        const branchId = auth.context.branchId;
        if (branchId === undefined) {
          return {
            outcome: 'deny',
            reason: 'no POS terminal branch on this session',
          };
        }
        return { outcome: 'target', target: { type: 'branch', branchId } };
      }

      case 'sessionTerminalBranch': {
        if (auth.context.branchId !== undefined) {
          // A `pos` session: TenantContextService already re-verified the
          // terminal's status and the employee's live branch permission on this
          // request, so no second read is warranted.
          return {
            outcome: 'target',
            target: { type: 'branch', branchId: auth.context.branchId },
          };
        }
        const terminalId = auth.context.terminalId;
        if (terminalId === undefined) {
          return { outcome: 'deny', reason: 'session is not terminal-bound' };
        }
        const branchId = await this.prisma.withAuthContext(
          { userId: auth.context.userId, tenantId: auth.context.tenantId },
          async (tx) => {
            const terminal = await tx.terminal.findUnique({
              where: { id: terminalId },
              select: { branchId: true, status: true },
            });
            // A revoked or suspended terminal has no operating branch. Failing
            // closed here matters: it is the same answer a revoked POS terminal
            // already gets from TenantContextService, so the two paths cannot
            // disagree about what a dead terminal may do.
            return terminal && terminal.status === 'active'
              ? terminal.branchId
              : null;
          },
        );
        if (branchId === null) {
          return { outcome: 'deny', reason: 'terminal is not active' };
        }
        return { outcome: 'target', target: { type: 'branch', branchId } };
      }

      case 'requestBranch': {
        const holder = (request as unknown as Record<string, unknown>)[
          spec.property
        ];
        const branchId =
          holder && typeof holder === 'object'
            ? (holder as Record<string, unknown>)[spec.key]
            : undefined;
        if (typeof branchId !== 'string' || !hasShape(branchId, 'uuid')) {
          return {
            outcome: 'deny',
            reason: `request.${spec.property}.${spec.key} not established`,
          };
        }
        return { outcome: 'target', target: { type: 'branch', branchId } };
      }

      case 'resource':
        return this.resolveResource(raw, auth, spec);

      case 'resourceOrTenant': {
        const anyKeyPresent = Object.values(spec.keys).some(
          (key) => readRaw(raw, key.source, key.key) !== undefined,
        );
        if (!anyKeyPresent) {
          return { outcome: 'target', target: { type: 'tenant' } };
        }
        return this.resolveResource(raw, auth, spec);
      }
    }
  }

  private async resolveResource(
    raw: RawRequest,
    auth: RequestAuthorization,
    spec: Extract<
      AuthorizationTargetSpec,
      { kind: 'resource' | 'resourceOrTenant' }
    >,
  ): Promise<TargetResolution> {
    const keys: Record<string, string | undefined> = {};
    for (const [name, key] of Object.entries(spec.keys) as [
      string,
      ResolverKeySpec,
    ][]) {
      const value = readRaw(raw, key.source, key.key);
      if (value === undefined) {
        if (key.optional) {
          continue;
        }
        return { outcome: 'deny', reason: `resource key '${key.key}' absent` };
      }
      if (!hasShape(value, key.format ?? 'uuid')) {
        return { outcome: 'defer', reason: `${key.key} is malformed` };
      }
      keys[name] = value;
    }

    let resolver: ScopeTargetResolver;
    try {
      resolver = this.moduleRef.get<ScopeTargetResolver>(spec.token, {
        strict: false,
      });
    } catch {
      // A route naming a resolver that is not wired is a build defect. It fails
      // CLOSED rather than falling back to a wider target.
      return {
        outcome: 'deny',
        reason: `no ScopeTargetResolver bound to ${String(spec.token)}`,
      };
    }

    const target = await this.prisma.withAuthContext(
      { userId: auth.context.userId, tenantId: auth.context.tenantId },
      (tx) => resolver.resolve(tx, { tenantId: auth.context.tenantId, keys }),
    );

    if (target === null) {
      // Not visible in this tenant — another tenant's, or nobody's. The route's
      // own lookup returns the repository's ordinary tenant-safe 404, which is
      // byte-identical for both cases (brief §6). Answering 403 here would make
      // the authorization layer itself the existence oracle the 404 exists to
      // prevent.
      return { outcome: 'defer', reason: 'resource not visible in tenant' };
    }
    return { outcome: 'target', target };
  }
}
