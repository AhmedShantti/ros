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
  type ScopeTargetResolver,
  type TargetIdFormat,
  type TargetIdSource,
} from '../contract/authorization-target';
import type { RequestAuthorization } from '../context/tenant-context';
import type { TargetScope } from './scope';

/**
 * The outcome of turning a request plus a declared spec into a TARGET SCOPE.
 *
 * ── EVERY OUTCOME TERMINATES OR DECIDES. THERE IS NO "CARRY ON UNSCOPED". ────
 * B1-3 originally had a fourth outcome, `defer`, which let the request proceed
 * to its handler when the target could not be resolved, on the reasoning that
 * the handler's own tenant-safe lookup would refuse it anyway. The acceptance
 * correction rejects that as a completion state, and rightly: "the handler will
 * probably refuse it" is a claim about every handler in the repository, present
 * and future, and it was already false for at least one route
 * (`GET /catalogue/branches/:branchId/menus` answered `200 []` for an unknown
 * branch — harmless in itself, but reached without any scope decision).
 *
 * So the resolver now always returns one of:
 *
 *   `target`     — a concrete scope; the primitive decides;
 *   `notFound`   — 404, using the route's OWN tenant-safe wording, so foreign
 *                  and non-existent stay byte-identical to each other and to
 *                  what the handler would have said;
 *   `badRequest` — 400, for input that cannot denote a resource at all.
 *
 * The handler runs only after a completed authorization decision.
 */
export type TargetResolution =
  | { readonly outcome: 'target'; readonly target: TargetScope }
  | { readonly outcome: 'deny'; readonly reason: string }
  | { readonly outcome: 'notFound'; readonly message: string }
  | { readonly outcome: 'badRequest'; readonly message: string };

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BUSINESS_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A business day must be a REAL calendar date, not merely `YYYY-MM-DD`-shaped.
 *
 * `2026-02-31` matches the pattern, and `new Date('2026-02-31T00:00:00Z')`
 * silently rolls it forward to 3 March. A resolver handed that would look up a
 * DIFFERENT day, find nothing, and answer 404 — turning a route's documented
 * `400 malformed date` into a not-found. The round-trip check is what keeps the
 * guard's answer the same as the route's own `parseBusinessDay`.
 */
function isCalendarDate(value: string): boolean {
  const match = BUSINESS_DAY_RE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}

function hasShape(value: string, format: TargetIdFormat): boolean {
  return format === 'businessDay' ? isCalendarDate(value) : UUID_RE.test(value);
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
 * resolved against Organisation inside the caller's RLS context and refused if
 * invisible in the acting tenant — indistinguishably from an id that does not
 * exist. `resource` targets are resolved by loading the addressed row
 * tenant-safely and reading its REAL owning scope, so a body or path id can only
 * ever select a resource, never assert its scope.
 */
@Injectable()
export class AuthorizationTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
  ) {}

  async resolve(
    request: Request,
    auth: RequestAuthorization,
    spec: AuthorizationTargetSpec,
  ): Promise<TargetResolution> {
    const preliminary = await this.resolveSpec(request, auth, spec);
    if (preliminary.outcome !== 'target') {
      return preliminary;
    }
    return this.finalizeBranchTarget(auth, preliminary.target, spec);
  }

  /**
   * T-12 — a branch that is not `active` is denied for EVERY scope, TENANT
   * included, on EVERY route.
   *
   * ── WHY THIS IS ONE CHECK AT THE END, NOT A CHECK PER KIND ────────────────
   * A branch target can arrive from a path parameter, a body field, a query
   * filter, live terminal state, an earlier guard, or the row of an addressed
   * resource. Checking "is it active?" in each of those places is six chances to
   * forget, and the two modules that DID check it (Reporting, Day Close) are
   * exactly the evidence that a per-module check does not generalise. Every
   * branch target — however it was derived — funnels through here.
   *
   * The brand comes back from the SAME query, so the lattice's BRAND→BRANCH limb
   * cannot see a different branch than the activity check did.
   *
   * Non-enumeration is preserved and the two refusals stay distinct on purpose:
   * an INVISIBLE branch (another tenant's, or nobody's) is the ordinary
   * tenant-safe **404**; a visible but INACTIVE branch of the caller's own
   * tenant is a **403**. Collapsing the second into a 404 would hide a branch
   * from the tenant that owns it; collapsing the first into a 403 would tell a
   * caller that another tenant's branch exists.
   */
  private async finalizeBranchTarget(
    auth: RequestAuthorization,
    target: TargetScope,
    spec: AuthorizationTargetSpec,
  ): Promise<TargetResolution> {
    if (target.type !== 'branch') {
      return { outcome: 'target', target };
    }

    const facts = await this.prisma.withAuthContext(
      { userId: auth.context.userId, tenantId: auth.context.tenantId },
      (tx) =>
        this.branchBrand.findBranchAuthorizationFacts(tx, target.branchId),
    );
    if (facts === null) {
      return { outcome: 'notFound', message: 'Branch not found.' };
    }

    const exempt = spec.kind === 'branch' && spec.allowInactive !== undefined;
    if (!facts.isActive && !exempt) {
      return { outcome: 'deny', reason: 'branch is not active' };
    }

    return {
      outcome: 'target',
      // The same query that established visibility yields the parent brand, so
      // `ScopeAuthorizationService` never makes a second round trip.
      target: {
        type: 'branch',
        branchId: target.branchId,
        brandId: facts.brandId,
      },
    };
  }

  private async resolveSpec(
    request: Request,
    auth: RequestAuthorization,
    spec: AuthorizationTargetSpec,
  ): Promise<TargetResolution> {
    const raw: RawRequest = {
      params: request.params ?? {},
      body: (request.body ?? {}) as Record<string, unknown>,
      query: request.query ?? {},
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
            outcome: 'badRequest',
            message: `${spec.key} is required.`,
          };
        }
        if (!hasShape(value, 'uuid')) {
          // A value of the wrong shape cannot denote any resource, so there is
          // nothing to authorize against. Answering 400 here — rather than
          // letting the request through to a ValidationPipe that may or may not
          // check this particular field — keeps the malformed-input status the
          // routes already document while guaranteeing the handler never runs.
          return {
            outcome: 'badRequest',
            message: `${spec.key} must be a UUID.`,
          };
        }
        return spec.kind === 'branch'
          ? { outcome: 'target', target: { type: 'branch', branchId: value } }
          : this.resolveVisibleBrand(auth, value);
      }

      case 'branchOrTenant': {
        const value = readRaw(raw, spec.source, spec.key);
        if (value === undefined) {
          // Unfiltered collection read = a genuinely tenant-wide request.
          return { outcome: 'target', target: { type: 'tenant' } };
        }
        if (!hasShape(value, 'uuid')) {
          return {
            outcome: 'badRequest',
            message: `${spec.key} must be a UUID.`,
          };
        }
        return {
          outcome: 'target',
          target: { type: 'branch', branchId: value },
        };
      }

      case 'declaredScope': {
        const declared = readRaw(raw, spec.source, spec.typeKey);
        if (declared === undefined) {
          return {
            outcome: 'badRequest',
            message: `${spec.typeKey} is required.`,
          };
        }
        if (declared === 'tenant') {
          return { outcome: 'target', target: { type: 'tenant' } };
        }
        if (declared !== 'brand' && declared !== 'branch') {
          return {
            outcome: 'badRequest',
            message: `${spec.typeKey} must be tenant, brand or branch.`,
          };
        }
        const key = declared === 'brand' ? spec.brandKey : spec.branchKey;
        const value = readRaw(raw, spec.source, key);
        if (value === undefined) {
          // A `brand`/`branch` scope declared with no id is MALFORMED, and the
          // row could not be created from it. Every such route already answers
          // 400; the guard answers it first so the handler never runs.
          return {
            outcome: 'badRequest',
            message: `${key} is required for ${declared} scope.`,
          };
        }
        if (!hasShape(value, 'uuid')) {
          return { outcome: 'badRequest', message: `${key} must be a UUID.` };
        }
        return declared === 'brand'
          ? this.resolveVisibleBrand(auth, value)
          : { outcome: 'target', target: { type: 'branch', branchId: value } };
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

  /** A brand id from the request, refused unless visible in the acting tenant. */
  private async resolveVisibleBrand(
    auth: RequestAuthorization,
    brandId: string,
  ): Promise<TargetResolution> {
    const visible = await this.prisma.withAuthContext(
      { userId: auth.context.userId, tenantId: auth.context.tenantId },
      (tx) => this.branchBrand.brandIsVisible(tx, brandId),
    );
    return visible
      ? { outcome: 'target', target: { type: 'brand', brandId } }
      : { outcome: 'notFound', message: 'Brand not found.' };
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
    for (const [name, key] of Object.entries(spec.keys)) {
      const value = readRaw(raw, key.source, key.key);
      if (value === undefined) {
        if (key.optional) {
          continue;
        }
        return { outcome: 'badRequest', message: `${key.key} is required.` };
      }
      if (!hasShape(value, key.format ?? 'uuid')) {
        return {
          outcome: 'badRequest',
          message:
            key.format === 'businessDay'
              ? `${key.key} must be a YYYY-MM-DD date.`
              : `${key.key} must be a UUID.`,
        };
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
      // Not visible in this tenant — another tenant's, or nobody's. Answered
      // with the route's OWN tenant-safe 404 wording, so the two cases stay
      // byte-identical to each other and the operation never runs unscoped.
      return { outcome: 'notFound', message: spec.notFound };
    }
    return { outcome: 'target', target };
  }
}
