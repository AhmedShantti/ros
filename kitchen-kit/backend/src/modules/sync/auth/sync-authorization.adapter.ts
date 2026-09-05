import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import {
  POS_ACTOR_AUTHORIZATION,
  SCOPE_AUTHORIZATION,
} from '../../identity/contract';
import type {
  PosActorAuthorizationPort,
  ScopeAuthorizationPort,
} from '../../identity/contract';
import type {
  SyncAuthorizationPort,
  SyncAuthorizationRequest,
} from '../contract/sync-authorization.port';

/**
 * D4-1B — the REAL binding of `SYNC_AUTHORIZATION_PORT` (`sync/contract/
 * sync-authorization.port.ts`), which D4-1A shipped deliberately unbound.
 *
 * Per the D1-1 ratification (§23) and this task's brief: "Use the published
 * Identity authorization primitive. Do not duplicate the scope lattice in
 * Sync." This adapter does exactly one thing — turn a `SyncAuthorizationRequest`
 * into the two Identity calls B1-3 already uses for every other business
 * operation:
 *
 *   1. `POS_ACTOR_AUTHORIZATION` resolves the asserted `actorEmployeeId` into a
 *      LIVE, `pos`-shaped actor (membership, effective role assignments, the
 *      EmployeeBranch AND-only narrowing) — see that contract's docblock for
 *      why Sync needs a separate entry point from the token-bound
 *      `TenantContextService.resolve`.
 *   2. `SCOPE_AUTHORIZATION` (`ScopeAuthorizationService`, B1-2/B1-3, UNCHANGED)
 *      decides `permission AND target scope` against that actor — the exact
 *      same primitive `PermissionGuard` uses for every HTTP route.
 *
 * JWT `scp`/`pbr` claims never enter this path at all: there is no JWT here,
 * only the operation's asserted `actorEmployeeId` and the terminal's live,
 * server-derived `branchId` — both already establish at
 * `SyncOperationContext` construction time (`sync-batch.service.ts`), never
 * read from the operation payload.
 *
 * ── D4-1B ACCEPTANCE CORRECTION — NFR-PERF-032 ────────────────────────────
 * When `request.actorCache` is supplied, step 1's resolved actor FACTS are
 * memoized batch-locally (see `actor-resolution.cache.ts`); step 2 —
 * `ScopeAuthorizationService.isAuthorized` — is UNCONDITIONALLY called for
 * every operation regardless of cache state, because it decides against that
 * operation's own target scope, which the cache does not and must not
 * capture.
 */
@Injectable()
export class SyncAuthorizationAdapter implements SyncAuthorizationPort {
  constructor(
    @Inject(POS_ACTOR_AUTHORIZATION)
    private readonly posActor: PosActorAuthorizationPort,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
  ) {}

  async isAllowed(
    tx: Prisma.TransactionClient,
    request: SyncAuthorizationRequest,
  ): Promise<boolean> {
    // `actorEmployeeId` is OPTIONAL on the envelope (system-originated
    // operations). No production D4-1B handler is system-originated, and a
    // permission-gated operation with no asserted actor has no authority to
    // evaluate — fail closed rather than falling back to the terminal's bare
    // identity, which the D1-1 ratification (§23) explicitly says is NOT
    // sufficient once a real permission is being enforced.
    if (!request.actorEmployeeId) {
      return false;
    }

    const { actorCache } = request;
    const cached = actorCache?.get(
      request.tenantId,
      request.terminalId,
      request.branchId,
      request.actorEmployeeId,
    );
    // `undefined` = not resolved yet this batch. A cached `null` (actor does
    // not exist / not permitted at this branch) is a real, reusable answer —
    // NOT a cache miss — so it must not trigger a redundant re-resolve.
    const actor =
      cached !== undefined
        ? cached
        : await this.posActor.resolve(tx, {
            tenantId: request.tenantId,
            employeeId: request.actorEmployeeId,
            branchId: request.branchId,
          });
    if (cached === undefined) {
      actorCache?.set(
        request.tenantId,
        request.terminalId,
        request.branchId,
        request.actorEmployeeId,
        actor,
      );
    }
    if (actor === null) {
      return false;
    }

    return this.scopeAuthorization.isAuthorized(
      actor,
      { codes: [request.permission], mode: 'all' },
      {
        type: 'branch',
        branchId: request.targetBranchId ?? request.branchId,
      },
      tx,
    );
  }
}
