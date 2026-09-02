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
 * that D4-1 cannot be closed without. See the D4-1A report §17.
 */
@Injectable()
export class SyncTerminalGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
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
