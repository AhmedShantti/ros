import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../../prisma/prisma.service';
import { TERMINAL_FACTS_QUERY } from '../../identity/contract';
import type {
  AuthenticatedPrincipal,
  TerminalFactsQuery,
} from '../../identity/contract';
import { BRANCH_BRAND_QUERY } from '../../organisation/contract';
import type { BranchBrandQuery } from '../../organisation/contract';

export interface SyncTerminal {
  readonly terminalId: string;
  /** Server-derived from the terminal's LIVE state, never from the body. */
  readonly branchId: string;
}

export type SyncAuthorizedRequest = Request & {
  principal?: AuthenticatedPrincipal;
  syncTerminal?: SyncTerminal;
};

/**
 * The fail-closed terminal gate for every sync route. Runs after
 * `JwtAuthGuard` (401) and `TenantContextGuard` (403).
 *
 * Each check is independently fail-closed:
 *   1. the session is terminal-bound at all (`principal.terminalId`);
 *   2. a tenant context exists;
 *   3. the terminal EXISTS and is `active`, read live from Identity through its
 *      published `TerminalFactsQuery` — never a direct read of an Identity
 *      table, and never a value carried on the token, so a terminal disabled or
 *      revoked mid-session is refused on its very next batch (`FR-OFF-032`:
 *      revocations "SHALL be re-verified on every reconnection");
 *   4. `body.deviceId` EQUALS the authenticated terminal. A terminal cannot
 *      upload on behalf of another terminal.
 *
 * On success `request.syncTerminal` carries the server-derived branch, so
 * nothing downstream ever re-derives it and nothing downstream can be tempted to
 * read it from the body.
 *
 * ── NO PERMISSION CODE IS REQUIRED, AND THAT IS DELIBERATE ────────────────
 * This repository treats inventing a permission code as needing explicit user
 * authorization — `kitchen.permissions.ts` records `kds.operate` as "the THIRD
 * explicit user-authorized exception to the zero-invented-codes discipline".
 * D4-1A has no such authorization, and the D1-1 ratification independently
 * limits this lane to "authenticated tenant, registered terminal, terminal
 * branch" while branch-scoped RBAC remains Lane B's. So the gate is terminal
 * identity, and `SYNC_AUTHORIZATION_PORT` (sync/contract) is the declared seam
 * where Lane B's answer attaches. `FR-SEC-002/003/004` are NOT claimed here.
 *
 * ── REVOKED TERMINALS ─────────────────────────────────────────────────────
 * A revoked terminal is refused ordinary sync, and that is the correct security
 * outcome. It is NOT a statement that its unsynced backlog may be discarded:
 * GD-D1-07 was REJECTED, committed-sale loss is explicitly not accepted
 * behaviour, and LOSSLESS REVOKED-TERMINAL RECOVERY is a ratified HARD GATE
 * — see `recovery/sync-recovery.controller.ts` for the D4-1B implementation.
 *
 * ── D4-1B — INACTIVE BRANCH × SYNC (closes the MW1C gap centrally) ─────────
 * MW1C proved that an ACTIVE terminal bound to an INACTIVE branch still
 * reached `SyncBatchService` — the terminal-active check above says nothing
 * about the BRANCH's own lifecycle. T-12 already states the rule for every
 * OTHER route: "a branch that is not `active` is denied for EVERY scope, TENANT
 * included" (`AuthorizationTargetResolver.finalizeBranchTarget`). Sync gets the
 * SAME answer from the SAME published query — `BRANCH_BRAND_QUERY
 * .findBranchAuthorizationFacts` — rather than a second, independently-written
 * definition of "operative branch" copied into every future handler. Checked
 * HERE, once, before `SyncController` ever reaches `SyncBatchService`, so no
 * handler executes, no effect applies, and no `operation_dedup` row is written
 * for a batch that never got this far.
 *
 * The branch is invisible only if the terminal's own FK is somehow dangling
 * (unreachable in practice — `identity.terminals.branch_id` is FK-enforced);
 * treated as fail-closed exactly like an inactive branch, using the SAME
 * generic wording as the terminal-inactive refusal above, so neither answer
 * becomes a distinguishing oracle for whatever produced it.
 */
@Injectable()
export class SyncTerminalGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
    @Inject(BRANCH_BRAND_QUERY)
    private readonly branchBrand: BranchBrandQuery,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SyncAuthorizedRequest>();
    const principal = request.principal;
    if (!principal?.terminalId) {
      throw new ForbiddenException('Sync requires a terminal-bound session.');
    }
    const tenantId = principal.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No active tenant context.');
    }
    const terminalId = principal.terminalId;

    const terminal = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.terminalFacts.getById(tx, terminalId),
    );
    if (!terminal) {
      throw new ForbiddenException('Terminal not found.');
    }
    if (terminal.status !== 'active') {
      throw new ForbiddenException(
        'This terminal is not active. Ordinary sync is refused. Committed ' +
          'offline transactions are NOT discarded by this refusal — recovery ' +
          'requires the separately authorised lossless recovery path.',
      );
    }

    const branchFacts = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.branchBrand.findBranchAuthorizationFacts(tx, terminal.branchId),
    );
    if (branchFacts === null || !branchFacts.isActive) {
      // Same generic, non-enumerating shape as the terminal-inactive refusal:
      // a caller must not be able to distinguish "your terminal is dead" from
      // "your terminal's branch is dead" from the response alone.
      throw new ForbiddenException(
        'This terminal is not active. Ordinary sync is refused. Committed ' +
          'offline transactions are NOT discarded by this refusal — recovery ' +
          'requires the separately authorised lossless recovery path.',
      );
    }

    const body: unknown = request.body;
    const deviceId =
      body !== null && typeof body === 'object'
        ? (body as { deviceId?: unknown }).deviceId
        : undefined;
    if (typeof deviceId === 'string' && deviceId !== terminalId) {
      throw new ForbiddenException(
        'deviceId does not match the authenticated terminal.',
      );
    }

    request.syncTerminal = { terminalId, branchId: terminal.branchId };
    return true;
  }
}
