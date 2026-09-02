import { Prisma } from '../../../generated/prisma/client';

/**
 * Sync PUBLIC contract — the BRANCH-RBAC INTEGRATION BOUNDARY.
 *
 * ── WHY THIS IS AN EMPTY-BY-DESIGN SEAM AND NOT AN IMPLEMENTATION ─────────
 * Branch-scoped authorization (`FR-SEC-002`/`003`/`004`) belongs to Lane B.
 * Governance `D-2` deferred general branch-aware permission resolution, and its
 * 2026-08-19 amendment lifted the defer only as far as `FR-SEC-021` required —
 * "permission resolution is NOT made branch-aware by this amendment". Lane B has
 * since reopened `D-2` in ITS OWN lane and `B1-2` is authorised, but that
 * implementation is **not present at this lane's code baseline**.
 *
 * The D1-1 ratification is explicit about what Sync must therefore do: "Do not
 * recreate a parallel permission model inside Sync", and — at this baseline —
 * "do not fake a branch permission answer".
 *
 * So this file declares the QUESTION and deliberately ships no answer. Nothing
 * in D4-1A injects it; nothing in D4-1A calls it. It exists so that when Lane B
 * integrates, wiring branch-scoped authorization into the sync kernel is a
 * provider registration plus one call site — not a redesign, and not the
 * discovery that Sync grew its own permission model in the meantime.
 *
 * ── WHAT AUTHORISES A SYNC BATCH TODAY ────────────────────────────────────
 * Exactly what the ratification permits and no more: an authenticated tenant, a
 * registered ACTIVE terminal, and that terminal's server-derived branch. That is
 * enforced by `SyncTerminalGuard`. No permission code is invented — this
 * repository's zero-invented-codes discipline treats a new code as requiring
 * explicit user authorization (see `kitchen.permissions.ts`, which records
 * `kds.operate` as "the THIRD explicit user-authorized exception"), and D4-1A
 * has no such authorization.
 *
 * `FR-SEC-002`/`003`/`004` are NOT claimed by this lane.
 */
export interface SyncAuthorizationRequest {
  readonly tenantId: string;
  readonly terminalId: string;
  /** The terminal's own branch, server-derived. */
  readonly branchId: string;
  /** Asserted by the terminal; see the D4-1A report §17. */
  readonly actorEmployeeId: string | null;
  /** The permission the operation requires, e.g. `pos.order.create`. */
  readonly permission: string;
  /**
   * The branch the OPERATION targets, when it differs from the terminal's own.
   * D4-1A never populates this; it is the shape Lane B's target-scope check
   * needs.
   */
  readonly targetBranchId?: string;
}

export interface SyncAuthorizationPort {
  /**
   * "Is this actor allowed to execute permission P at the terminal branch /
   * target scope?"
   */
  isAllowed(
    tx: Prisma.TransactionClient,
    request: SyncAuthorizationRequest,
  ): Promise<boolean>;
}

/**
 * DI token. INTENTIONALLY UNBOUND in `SyncModule`: an unbound token fails loudly
 * at wiring time if someone tries to consume it before Lane B lands, which is
 * the correct failure. A default "always true" binding would be exactly the
 * faked answer the ratification forbids, and a default "always false" would
 * silently disable a protocol that is supposed to work today.
 */
export const SYNC_AUTHORIZATION_PORT = Symbol('SYNC_AUTHORIZATION_PORT');
