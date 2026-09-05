import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';
import {
  IDENTITY_PERMISSIONS,
  SCOPE_AUTHORIZATION,
  TERMINAL_FACTS_QUERY,
} from '../../identity/contract';
import type {
  RequestAuthorization,
  ScopeAuthorizationPort,
  TerminalFactsQuery,
} from '../../identity/contract';
import type { SyncBatchResult } from '../batch/sync-batch.service';

const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 1440;

export interface IssueRecoveryGrantInput {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly authorizedByMembershipId: string;
  readonly reason: string;
  readonly ttlMinutes?: number;
}

export interface RecoveryGrantView {
  readonly id: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Returned by `authorizeGrantForBatch` when the batch may proceed. */
export interface AuthorizedRecoveryBatch {
  readonly terminalId: string;
  readonly branchId: string;
}

/**
 * D4-1B — the LOSSLESS REVOKED-TERMINAL RECOVERY hard gate. See the
 * `SyncRecoveryGrant` model's docblock (`prisma/schema.prisma`) and migration
 * 38 for why this is a table of its own rather than a field on one of D4-1A's
 * six.
 *
 * ── WHY THE UPLOAD ITSELF IS ADMIN-AUTHENTICATED, NOT TERMINAL-AUTHENTICATED ─
 * The obvious design — the revoked terminal presents its own Bearer token to a
 * dedicated upload route — does not survive contact with two OTHER ratified
 * rules: `PinService.authenticate` refuses a non-`active` terminal outright
 * (FR-SEC-028, "a revoked or unregistered terminal fails immediately"), so a
 * revoked terminal cannot mint a NEW session token; and even a token minted
 * BEFORE revocation is only usable while it has not expired, which the
 * SRS's own long-offline scenario (CR-01, up to 72 hours) can easily outlast.
 * A terminal-authenticated recovery route would therefore be unreachable in
 * exactly the case it exists for. `TenantContextService.resolvePosBranch`
 * independently refuses ANY `pos`-session request for a non-`active`
 * terminal, unconditionally, for every route that carries a POS session —
 * there is no route-level opt-out of that check.
 *
 * The recovery grant is therefore the authority, and the actor who WIELDS it
 * is an authenticated, permissioned ADMIN (the same `identity.terminal
 * .manage` holder who could issue the grant in the first place, or another
 * with the same live authority) — realistically the person who extracted the
 * committed backlog from the physical/revoked device. This is a STRICTER
 * reading of D1-1 §21.3 invariant 2 ("explicitly authorised"), not a weaker
 * one: recovery now requires a real, live-authorized human at BOTH steps
 * (grant issuance and batch upload), rather than trusting a bearer token the
 * terminal happens to still hold.
 *
 * This service owns exactly two decisions:
 *   1. `issueGrant` — may an admin authorize a bounded recovery window for
 *      THIS terminal right now? (Only for a terminal `SyncTerminalGuard`
 *      would otherwise refuse — an ACTIVE terminal already has the ordinary
 *      path, and a second concurrently-open grant is refused so "bounded"
 *      stays true of the terminal, not just of one grant.)
 *   2. `authorizeGrantForBatch` — may THIS admin upload THIS specific batch
 *      under THIS grant? Checks LIVE `identity.terminal.manage` at the
 *      grant's own branch (`SCOPE_AUTHORIZATION`, the SAME primitive
 *      `PermissionGuard` uses — not re-decided here, just invoked
 *      programmatically because the target branch is only known after the
 *      grant is loaded, which a static `@AuthorizationTarget` cannot express).
 *      One-shot per logical batch (a retry of the SAME batchId is still
 *      honoured, matching `SyncBatchService`'s own crash-recovery replay
 *      contract; any OTHER batchId against an already-consumed grant is
 *      refused).
 *
 * Everything downstream of a success from (2) — handler execution, per-op
 * `SYNC_AUTHORIZATION_PORT` authority (still keyed on the OPERATION's own
 * `actorEmployeeId`, unaffected by which admin uploaded the batch),
 * `(tenant_id, op_id)` dedup, conflict/revalidation recording — is the
 * UNMODIFIED `SyncBatchService.process` pipeline. This service never touches
 * a domain table and never flips `identity.terminals.status`.
 */
@Injectable()
export class SyncRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TERMINAL_FACTS_QUERY)
    private readonly terminalFacts: TerminalFactsQuery,
    @Inject(SCOPE_AUTHORIZATION)
    private readonly scopeAuthorization: ScopeAuthorizationPort,
    private readonly audit: AuditService,
  ) {}

  async issueGrant(input: IssueRecoveryGrantInput): Promise<RecoveryGrantView> {
    const ttlMinutes = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    if (ttlMinutes < 1 || ttlMinutes > MAX_TTL_MINUTES) {
      throw new BadRequestException(
        `ttlMinutes must be between 1 and ${MAX_TTL_MINUTES}.`,
      );
    }

    return this.prisma.withAuthContext(
      { tenantId: input.tenantId },
      async (tx) => {
        const terminal = await this.terminalFacts.getById(tx, input.terminalId);
        if (!terminal) {
          throw new NotFoundException('Terminal not found.');
        }
        // Recovery exists for the channel `SyncTerminalGuard` refuses. An
        // active terminal already has the ordinary path — granting recovery
        // alongside it would be a second, parallel authorization surface for
        // the SAME committed-backlog upload, contradicting "bounded to the
        // revoked terminal's committed backlog" by widening it to "any time".
        if (terminal.status === 'active') {
          throw new ConflictException(
            'This terminal is active; ordinary sync already accepts its ' +
              'backlog. Recovery grants exist for a disabled/revoked ' +
              'terminal only.',
          );
        }

        const openGrant = await tx.syncRecoveryGrant.findFirst({
          where: {
            tenantId: input.tenantId,
            terminalId: terminal.id,
            status: 'pending',
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        });
        if (openGrant) {
          throw new ConflictException(
            'A pending recovery grant already exists for this terminal. Wait ' +
              'for it to be consumed or expire before issuing another.',
          );
        }

        const id = newId();
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
        await tx.syncRecoveryGrant.create({
          data: {
            id,
            tenantId: input.tenantId,
            terminalId: terminal.id,
            branchId: terminal.branchId,
            authorizedByMembershipId: input.authorizedByMembershipId,
            reason: input.reason,
            status: 'pending',
            issuedAt,
            expiresAt,
          },
        });

        await this.audit.record(tx, {
          tenantId: input.tenantId,
          action: AUDIT_ACTION.TERMINAL_RECOVERY_GRANTED,
          entityType: AUDIT_ENTITY.SYNC_RECOVERY_GRANT,
          actorType: 'user',
          actorId: input.authorizedByMembershipId,
          entityId: id,
          terminalId: terminal.id,
          reasonText: input.reason,
          metadata: {
            branchId: terminal.branchId,
            expiresAt: expiresAt.toISOString(),
          },
        });

        return {
          id,
          terminalId: terminal.id,
          branchId: terminal.branchId,
          status: 'pending',
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        };
      },
    );
  }

  /**
   * Gate a specific batch upload against a specific grant, on behalf of the
   * AUTHENTICATED ADMIN performing it (`auth`). Runs in its OWN short
   * transaction — deliberately separate from `SyncBatchService.process`'s
   * internal transaction/savepoint machinery (D4-1A's kernel is not modified
   * for this).
   *
   * Throws (never returns a partial/ambiguous result):
   *   - `NotFoundException` — no such grant in this tenant.
   *   - `ForbiddenException` (from `SCOPE_AUTHORIZATION.assertAuthorized`) —
   *     the caller does not hold live `identity.terminal.manage` at the
   *     grant's own branch.
   *   - `ConflictException` — the grant is expired, already consumed for a
   *     DIFFERENT batchId, or was revoked.
   *
   * A retry of the SAME batchId this grant was already consumed for is a
   * resubmission, not a second use — `SyncBatchService.process` itself
   * resolves it via `sync.sync_batches`' own fingerprint/replay logic; this
   * method still re-checks live authorization on every call, retries
   * included.
   */
  async authorizeGrantForBatch(
    auth: RequestAuthorization,
    tenantId: string,
    grantId: string,
    batchId: string,
  ): Promise<AuthorizedRecoveryBatch> {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const grant = await tx.syncRecoveryGrant.findFirst({
        where: { id: grantId, tenantId },
      });
      if (!grant) {
        throw new NotFoundException('Recovery grant not found.');
      }

      await this.scopeAuthorization.assertAuthorized(
        auth,
        { codes: [IDENTITY_PERMISSIONS.TERMINAL_MANAGE], mode: 'all' },
        { type: 'branch', branchId: grant.branchId },
        tx,
      );

      if (grant.status === 'consumed') {
        if (grant.consumedBatchId === batchId) {
          return { terminalId: grant.terminalId, branchId: grant.branchId };
        }
        throw new ConflictException(
          'This recovery grant was already used to upload a different batch.',
        );
      }
      if (grant.status === 'revoked') {
        throw new ConflictException('This recovery grant was revoked.');
      }
      if (grant.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException('This recovery grant has expired.');
      }

      const claimed = await tx.syncRecoveryGrant.updateMany({
        where: {
          id: grantId,
          tenantId,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
        data: {
          status: 'consumed',
          consumedAt: new Date(),
          consumedBatchId: batchId,
        },
      });
      if (claimed.count !== 1) {
        // Lost a race to a concurrent claim of the SAME grant.
        throw new ConflictException(
          'This recovery grant was concurrently consumed by another request.',
        );
      }

      await this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.TERMINAL_RECOVERY_BATCH_ACCEPTED,
        entityType: AUDIT_ENTITY.SYNC_RECOVERY_GRANT,
        actorType: 'user',
        actorId: auth.context.membershipId,
        entityId: grantId,
        terminalId: grant.terminalId,
        metadata: { batchId },
      });

      return { terminalId: grant.terminalId, branchId: grant.branchId };
    });
  }

  /** Best-effort completion record — the per-op audit trail already happened
   * atomically inside `SyncBatchService.process`; this is the batch-level
   * summary linking that trail back to the recovery grant that authorized it. */
  async recordBatchProcessed(
    tenantId: string,
    grantId: string,
    result: SyncBatchResult,
  ): Promise<void> {
    await this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.TERMINAL_RECOVERY_BATCH_PROCESSED,
        entityType: AUDIT_ENTITY.SYNC_RECOVERY_GRANT,
        actorType: 'system',
        entityId: grantId,
        metadata: {
          batchId: result.batchId,
          counts: result.counts,
        },
      }),
    );
  }
}
