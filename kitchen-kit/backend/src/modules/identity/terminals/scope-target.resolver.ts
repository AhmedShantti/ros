import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
} from '../contract/authorization-target';
import type { TargetScope } from '../authz/scope';

/**
 * PRIVATE implementation of `IDENTITY_TERMINAL_TARGET_RESOLVER`.
 *
 * A terminal is BRANCH-owned: `identity.terminals.branch_id` is NOT NULL and
 * carries the tenant-safe composite FK the 2026-08-19 D-2 amendment added.
 * Revoking or re-fingerprinting a terminal is therefore an act against that
 * terminal's branch, and a branch manager must not be able to revoke a terminal
 * standing in another branch.
 *
 * The row's status is irrelevant here: an ALREADY-revoked terminal still belongs
 * to its branch, and reactivating it must be authorized at that same branch.
 */
@Injectable()
export class TerminalTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const terminalId = input.keys.terminalId;
    if (!terminalId) return null;
    const terminal = await tx.terminal.findUnique({
      where: { id: terminalId },
      select: { branchId: true },
    });
    return terminal ? { type: 'branch', branchId: terminal.branchId } : null;
  }
}
